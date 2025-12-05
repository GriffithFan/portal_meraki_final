const fs = require('fs');
const path = require('path');
const { logger } = require('./config/logger');

/**
 * Módulo para gestión de códigos de predios via CSV
 * Optimiza búsquedas eliminando la necesidad de emparejar predio con organización
 */

const CSV_PATH = path.join(__dirname, '..', 'data', 'predios.csv');
let prediosCache = null;
let lastModified = null;

function parseCsvLine(line) {
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

/**
 * Carga el CSV de predios en memoria
 */
function loadPrediosFromCSV() {
  try {
    if (!fs.existsSync(CSV_PATH)) {
      logger.warn('Archivo predios.csv no encontrado. Creando plantilla...');
      createSampleCSV();
      return new Map();
    }

    const stats = fs.statSync(CSV_PATH);
    
    // Si ya está cacheado y no ha cambiado, devolver cache
    if (prediosCache && lastModified && stats.mtime <= lastModified) {
      return prediosCache;
    }

    const csvContent = fs.readFileSync(CSV_PATH, 'utf8');
    const lines = csvContent.split('\n').filter(line => line.trim());
    
    if (lines.length < 2) {
      logger.warn('CSV de predios vacío o sin datos');
      return new Map();
    }

    const header = parseCsvLine(lines[0]);
    const prediosMap = new Map();
    const uniqueNetworkIds = new Set();

    for (let i = 1; i < lines.length; i++) {
      const values = parseCsvLine(lines[i]);
      if (values.length >= header.length) {
        const predio = {};
        header.forEach((key, index) => {
          predio[key.trim()] = values[index] ? values[index].trim() : '';
        });

        // Indexar por network_id y por predio_code
        if (predio.network_id) {
          prediosMap.set(predio.network_id, predio);
          uniqueNetworkIds.add(predio.network_id);
        }
        if (predio.predio_code) {
          prediosMap.set(predio.predio_code, predio);
        }
      }
    }

    prediosCache = prediosMap;
    lastModified = stats.mtime;
  logger.info(`Cargados ${uniqueNetworkIds.size} predios desde CSV`);
    
    return prediosMap;
  } catch (error) {
    logger.error('Error cargando predios.csv:', { error: error.message });
    return new Map();
  }
}

/**
 * Busca un predio por código o network ID
 */
function findPredio(query) {
  const predios = loadPrediosFromCSV();
  return predios.get(query) || null;
}

/**
 * Busca predios por filtros múltiples
 */
function searchPredios(filters = {}) {
  const predios = loadPrediosFromCSV();
  const results = [];
  
  predios.forEach((predio, key) => {
    // Evitar duplicados (el Map tiene entries por network_id Y predio_code)
    if (!key.startsWith('L_')) return;
    
    let matches = true;
    
    // Filtrar por región
    if (filters.region && predio.region.toLowerCase() !== filters.region.toLowerCase()) {
      matches = false;
    }
    
    // Filtrar por estado
    if (filters.estado && predio.estado.toLowerCase() !== filters.estado.toLowerCase()) {
      matches = false;
    }
    
    // Filtrar por organización
    if (filters.organization_id && predio.organization_id !== filters.organization_id) {
      matches = false;
    }
    
    // Búsqueda de texto en nombre
    if (filters.search) {
      const searchTerm = filters.search.toLowerCase();
      const searchableText = `${predio.predio_name} ${predio.predio_code}`.toLowerCase();
      if (!searchableText.includes(searchTerm)) {
        matches = false;
      }
    }
    
    if (matches) {
      results.push(predio);
    }
  });
  
  return results;
}

/**
 * Obtiene el network_id para un código de predio
 */
function getNetworkIdForPredio(predioCode) {
  const predio = findPredio(predioCode);
  return predio ? predio.network_id : null;
}

/**
 * Obtiene información completa de predio para un network_id
 */
function getPredioInfoForNetwork(networkId) {
  const predio = findPredio(networkId);
  return predio || {
    network_id: networkId,
    predio_code: 'UNKNOWN',
    predio_name: 'Red no catalogada',
    organization_id: '',
    region: 'Sin asignar',
    estado: 'desconocido'
  };
}

/**
 * Crea un CSV de ejemplo si no existe
 */
function createSampleCSV() {
  const sampleData = `network_id,predio_code,predio_name,organization_id,organization_name,region,estado
L_123456789012345678,PRD001,Sucursal Centro,654321,Organización Norte,Norte,activo
L_123456789012345679,PRD002,Sucursal Plaza,654321,Organización Norte,Sur,activo
L_123456789012345680,PRD003,Oficina Corporativa,654321,Organización Norte,Centro,activo
L_123456789012345681,PRD004,Almacén Principal,654322,Organización Este,Este,activo
L_123456789012345682,PRD005,Centro de Distribución,654322,Organización Este,Oeste,mantenimiento`;

  const dataDir = path.dirname(CSV_PATH);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  fs.writeFileSync(CSV_PATH, sampleData);
  logger.info('Creado archivo predios.csv de ejemplo');
}

/**
 * Refresca el caché forzando recarga del CSV
 */
function refreshCache() {
  prediosCache = null;
  lastModified = null;
  return loadPrediosFromCSV();
}

/**
 * Obtiene estadísticas del CSV
 */
function getStats() {
  const predios = loadPrediosFromCSV();
  const uniquePredios = [];
  
  predios.forEach((predio, key) => {
    if (key.startsWith('L_')) {
      uniquePredios.push(predio);
    }
  });
  
  const stats = {
    total: uniquePredios.length,
    porRegion: {},
    porEstado: {},
    porOrganizacion: {}
  };
  
  uniquePredios.forEach(predio => {
    // Contar por región
    stats.porRegion[predio.region] = (stats.porRegion[predio.region] || 0) + 1;
    
    // Contar por estado
    stats.porEstado[predio.estado] = (stats.porEstado[predio.estado] || 0) + 1;
    
    // Contar por organización
    stats.porOrganizacion[predio.organization_id] = (stats.porOrganizacion[predio.organization_id] || 0) + 1;
  });
  
  return stats;
}

module.exports = {
  findPredio,
  searchPredios,
  getNetworkIdForPredio,
  getPredioInfoForNetwork,
  refreshCache,
  getStats,
  loadPrediosFromCSV
};