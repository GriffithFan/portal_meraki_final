const fs = require('fs');
const path = require('path');

const { logger } = require('./config/logger');
const { getOrganizations, getNetworks } = require('./merakiApi');
const { loadPrediosFromCSV, refreshCache } = require('./prediosManager');
const { extractPredioCode, determineRegion, determineEstado } = require('../scripts/loadAllPredios');

const CSV_PATH = path.join(__dirname, '..', 'data', 'predios.csv');
const DEFAULT_INTERVAL_MINUTES = 180; // 3 horas por defecto para evitar rate limiting

let refreshInProgress = false;
let lastRunSummary = null;

function getConfiguredOrgIds() {
  const raw = process.env.MERAKI_ORG_ID || process.env.MERAKI_ORG_IDS;
  if (!raw) return null;
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

function ensureCsvHeader() {
  if (fs.existsSync(CSV_PATH)) return;
  const header = 'network_id,predio_code,predio_name,organization_id,region,estado\n';
  fs.mkdirSync(path.dirname(CSV_PATH), { recursive: true });
  fs.writeFileSync(CSV_PATH, header, 'utf8');
}

function escapeCsvField(value) {
  if (value == null) return '';
  const str = String(value);
  if (!/[",\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function parseCsvLine(line = '') {
  const values = [];
  let current = '';
  let insideQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (insideQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values.map((value) => value.trim());
}

function formatCsvRow(predio) {
  const columns = [
    predio.network_id,
    predio.predio_code,
    escapeCsvField(predio.predio_name),
    predio.organization_id,
    predio.region,
    predio.estado,
  ];
  return columns.join(',');
}

async function resolveTargetOrganizations() {
  const configured = getConfiguredOrgIds();
  if (configured && configured.length) {
    return configured.map((id) => ({ id, name: null }));
  }
  const orgs = await getOrganizations();
  return orgs.map((org) => ({ id: org.id, name: org.name }));
}

async function collectExistingNetworkIds() {
  const existing = loadPrediosFromCSV();
  const networkIds = new Set();
  existing.forEach((value, key) => {
    if (!key) return;
    if (key.startsWith('L_') || key.startsWith('N_')) {
      networkIds.add(key);
      return;
    }
    const networkId = value?.network_id;
    if (networkId && (networkId.startsWith('L_') || networkId.startsWith('N_'))) {
      networkIds.add(networkId);
    }
  });
  return networkIds;
}

async function fetchNetworksForOrg(org) {
  try {
    const networks = await getNetworks(org.id);
    return networks || [];
  } catch (error) {
    logger.error(`Error obteniendo redes para la organización ${org.id}:`, { data: error.response?.data || error.message });
    return [];
  }
}

async function buildPredioRecords(org, networks) {
  return networks.map((network) => ({
    network_id: network.id,
    predio_code: extractPredioCode(network.name || network.id),
    predio_name: network.name || network.id,
    organization_id: org.id,
    region: determineRegion(network.name || '', org.name || ''),
    estado: determineEstado(network.name || ''),
  }));
}

async function appendPrediosToCsv(newPredios) {
  if (!newPredios.length) return;
  ensureCsvHeader();
  const rows = newPredios.map(formatCsvRow).join('\n');
  fs.appendFileSync(CSV_PATH, `${rows}\n`, 'utf8');
}

function writePrediosCsv(predios) {
  const dir = path.dirname(CSV_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const header = 'network_id,predio_code,predio_name,organization_id,region,estado';
  const rows = predios.map(formatCsvRow);
  const content = rows.length ? `${header}\n${rows.join('\n')}\n` : `${header}\n`;
  fs.writeFileSync(CSV_PATH, content, 'utf8');
}

function dedupeCsvFile() {
  if (!fs.existsSync(CSV_PATH)) {
    return { removed: 0, retained: 0 };
  }

  const content = fs.readFileSync(CSV_PATH, 'utf8');
  const lines = content.split(/\r?\n/).filter((line) => line.trim().length);
  if (lines.length <= 1) {
    return { removed: 0, retained: Math.max(0, lines.length - 1) };
  }

  const header = parseCsvLine(lines[0]);
  const expectedColumns = header.length;
  const uniqueByNetwork = new Map();

  for (let i = 1; i < lines.length; i += 1) {
    const values = parseCsvLine(lines[i]);
    if (values.length < expectedColumns) continue;
    const record = {};
    header.forEach((key, idx) => {
      record[key.trim()] = values[idx] ? values[idx].trim() : '';
    });
    const networkId = record.network_id;
    if (!networkId) continue;
    if (!uniqueByNetwork.has(networkId)) {
      uniqueByNetwork.set(networkId, record);
    }
  }

  const deduped = Array.from(uniqueByNetwork.values()).sort((a, b) => a.network_id.localeCompare(b.network_id));
  const originalCount = lines.length - 1;
  const removed = originalCount - deduped.length;

  if (removed <= 0) {
    return { removed: 0, retained: deduped.length };
  }

  writePrediosCsv(deduped);
  refreshCache();
  return { removed, retained: deduped.length };
}

async function syncPrediosCsv({ force = false } = {}) {
  if (refreshInProgress) {
    return { skipped: true, reason: 'refresh-in-progress' };
  }

  refreshInProgress = true;
  const start = Date.now();
  const summary = {
    startedAt: new Date().toISOString(),
    totalOrganizations: 0,
    processedOrganizations: 0,
    newPredios: 0,
    skippedOrganizations: 0,
    failures: [],
    mode: force ? 'rebuild' : 'append',
    totalPredios: 0,
    dedupedRows: 0,
  };

  let existingNetworkIds = new Set();
  let rebuildAccumulator = null;

  try {
    if (!force) {
      ensureCsvHeader();
    }
    existingNetworkIds = force ? new Set() : await collectExistingNetworkIds();
    const organizations = await resolveTargetOrganizations();
    summary.totalOrganizations = organizations.length;

    const newPrediosAccumulator = [];
    rebuildAccumulator = force ? new Map() : null;

    for (const org of organizations) {
      const networks = await fetchNetworksForOrg(org);
      if (!networks.length) {
        summary.skippedOrganizations += 1;
        continue;
      }

      const candidatePredios = await buildPredioRecords(org, networks);
      if (force && rebuildAccumulator) {
        candidatePredios.forEach((predio) => {
          rebuildAccumulator.set(predio.network_id, predio);
        });
      } else {
        const newEntries = candidatePredios.filter((predio) => !existingNetworkIds.has(predio.network_id));

        if (newEntries.length) {
          newEntries.forEach((predio) => existingNetworkIds.add(predio.network_id));
          newPrediosAccumulator.push(...newEntries);
        }
      }

      summary.processedOrganizations += 1;
    }

    if (force && rebuildAccumulator) {
      const allPredios = Array.from(rebuildAccumulator.values());
      allPredios.sort((a, b) => {
        if (a.predio_code && b.predio_code && a.predio_code !== b.predio_code) {
          return a.predio_code.localeCompare(b.predio_code);
        }
        return a.network_id.localeCompare(b.network_id);
      });
      writePrediosCsv(allPredios);
      summary.newPredios = allPredios.length;
      summary.mode = 'rebuild';
      summary.totalPredios = allPredios.length;
      refreshCache();
    } else {
      if (newPrediosAccumulator.length) {
        await appendPrediosToCsv(newPrediosAccumulator);
        summary.newPredios = newPrediosAccumulator.length;
        refreshCache();
      }
      summary.mode = 'append';
      summary.totalPredios = existingNetworkIds.size;
    }

    const dedupeInfo = dedupeCsvFile();
    summary.dedupedRows = dedupeInfo.removed;
    if (dedupeInfo.retained) {
      summary.totalPredios = dedupeInfo.retained;
    }
    if (dedupeInfo.removed > 0) {
      refreshCache();
      logger.info(`CSV de predios deduplicado: ${dedupeInfo.removed} filas eliminadas, ${dedupeInfo.retained} vigentes.`);
    }

    summary.durationMs = Date.now() - start;
    summary.finishedAt = new Date().toISOString();
    lastRunSummary = summary;
    return summary;
  } catch (error) {
  const message = error.response?.data || error.message;
  logger.error('Error sincronizando predios:', { error: message });
    if (!summary.totalPredios) {
      summary.totalPredios = force && rebuildAccumulator ? rebuildAccumulator.size : existingNetworkIds.size;
    }
    summary.failures.push({ stage: 'sync', message });
    summary.durationMs = Date.now() - start;
    summary.finishedAt = new Date().toISOString();
    lastRunSummary = summary;
    return summary;
  } finally {
    refreshInProgress = false;
  }
}

function startPrediosAutoRefresh() {
  const intervalMinutes = Number(process.env.PREDIOS_REFRESH_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logger.info('Auto refresh de predios deshabilitado (intervalo inválido o <= 0).');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  const initialDelayMs = Number(process.env.PREDIOS_REFRESH_INITIAL_DELAY_MS || 30_000);

  const scheduleRun = () => {
      syncPrediosCsv().then((result) => {
      if (result.skipped) {
        logger.info('Sincronización de predios saltada (ejecución en curso).');
        return;
      }
      logger.info(`Sincronización de predios completada: ${result.newPredios} nuevos, ${result.processedOrganizations}/${result.totalOrganizations} orgs procesadas en ${result.durationMs}ms.`);
    }).catch((error) => {
      logger.error('Error en ejecución periódica de predios:', { data: error.response?.data || error.message });
    });
  };

  if (initialDelayMs >= 0) {
    setTimeout(scheduleRun, initialDelayMs);
  }
  setInterval(scheduleRun, intervalMs);

  logger.info(`Auto refresh de predios habilitado cada ${intervalMinutes} minutos (primer ejecución en ${initialDelayMs}ms).`);
}

function getLastRunSummary() {
  return lastRunSummary;
}

module.exports = {
  startPrediosAutoRefresh,
  syncPrediosCsv,
  getLastRunSummary,
  dedupeCsvFile,
};
