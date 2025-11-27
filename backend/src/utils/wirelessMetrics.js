const DEFAULT_WIRELESS_TIMESPAN = 86400; // 24h para métricas de señal

function composeWirelessMetrics({
  accessPoints = [],
  networkId = null,
  signalByDeviceRaw = [],
  signalHistoryRaw = [],
  signalByClientRaw = [],
  signalByNetworkRaw = [],
  failedConnectionsRaw = [],
  timespanSeconds = null,
} = {}) {
  if (!Array.isArray(accessPoints) || accessPoints.length === 0) {
    return null;
  }

  const toArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    if (typeof value === 'object') {
      if (Array.isArray(value.items)) return value.items;
      if (Array.isArray(value.data)) return value.data;
      if (Array.isArray(value.results)) return value.results;
      if (Array.isArray(value.entries)) return value.entries;
      if (Array.isArray(value.records)) return value.records;
      if (Array.isArray(value.values)) return value.values;
    }
    return [value];
  };

  const toNumber = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) return value;
      return null;
    }
    if (typeof value === 'string') {
      const cleaned = value.replace(/[^0-9+\-.]/g, '');
      if (!cleaned) return null;
      const parsed = Number(cleaned);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };

  const serialKeyOf = (value) => {
    if (!value && value !== 0) return null;
    const text = value.toString().trim().toUpperCase();
    return text || null;
  };

  const registerSerialEntry = (map, serial, value) => {
    const key = serialKeyOf(serial);
    if (!key) return;
    map.set(key, value);
    const compact = key.replace(/-/g, '');
    if (compact && compact !== key && !map.has(compact)) {
      map.set(compact, value);
    }
  };

  const pushSerialBucket = (map, serial, value) => {
    const key = serialKeyOf(serial);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
    const compact = key.replace(/-/g, '');
    if (compact && compact !== key) {
      if (!map.has(compact)) map.set(compact, []);
      map.get(compact).push(value);
    }
  };

  const sanitizeDeviceSignalEntry = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const average = toNumber(entry.averageSignalQuality ?? entry.signalQuality ?? entry.average ?? entry.avg ?? entry.mean ?? entry.value);
    const median = toNumber(entry.medianSignalQuality ?? entry.median ?? null);
    const min = toNumber(entry.minSignalQuality ?? entry.min ?? entry.minimum);
    const max = toNumber(entry.maxSignalQuality ?? entry.max ?? entry.maximum);
    const last = toNumber(entry.lastSignalQuality ?? entry.last ?? entry.latest);
    const sampleCount = toNumber(entry.sampleCount ?? entry.samples ?? entry.count ?? entry.totalMeasurements ?? entry.measurements);
    const coverage = toNumber(entry.coverage ?? entry.coveragePercentage ?? entry.percentCoverage);
    const lastSeen = entry.lastReportedAt || entry.timestamp || entry.lastSeen || entry.observedAt || entry.updatedAt || null;
    return {
      average,
      median,
      min,
      max,
      last,
      sampleCount,
      coverage,
      lastSeen,
    };
  };

  const normalizeSignalSample = (sample) => {
    if (!sample || typeof sample !== 'object') return null;
    const tsRaw = sample.ts || sample.timestamp || sample.time || sample.observedAt || sample.lastSeen || sample.at || null;
    let epochMs = null;
    if (tsRaw) {
      const parsed = new Date(tsRaw);
      if (!Number.isNaN(parsed.getTime())) epochMs = parsed.getTime();
    }
    const quality = toNumber(sample.signalQuality ?? sample.quality ?? sample.value ?? sample.score ?? sample.signal);
    const clients = toNumber(sample.clients ?? sample.clientCount ?? sample.connectedClients ?? sample.activeClients);
    const snr = toNumber(sample.snr ?? sample.signalToNoise ?? sample.signalToNoiseRatio ?? sample.signalNoiseRatio);
    const channel = sample.channel || sample.radio || null;
    const status = sample.status || sample.health || sample.state || null;
    return {
      ts: tsRaw || (epochMs ? new Date(epochMs).toISOString() : null),
      epochMs,
      signalQuality: quality,
      clients,
      snr,
      channel,
      status,
    };
  };

  const extractHistorySamples = (entry) => {
    if (!entry) return [];
    if (Array.isArray(entry)) return entry;
    const buckets = [];
    const pushArray = (value) => {
      if (Array.isArray(value) && value.length) {
        buckets.push(...value);
      }
    };
    if (typeof entry === 'object') {
      pushArray(entry.samples);
      pushArray(entry.signalQuality);
      pushArray(entry.signalQualityHistory);
      pushArray(entry.history);
      pushArray(entry.metrics);
      pushArray(entry.data);
      pushArray(entry.points);
      pushArray(entry.values);
      pushArray(entry.series);
      pushArray(entry.timeseries);
      pushArray(entry.items);
      pushArray(entry.entries);
      pushArray(entry.records);
      pushArray(entry.measurements);
      pushArray(entry.readings);
      pushArray(entry.samplesByRadio);
    }
    return buckets;
  };

  const normalizeClientSignal = (entry) => {
    if (!entry || typeof entry !== 'object') return null;
    const serial = entry.apSerial || entry.deviceSerial || entry.serial || entry.accessPointSerial;
    const id = entry.clientId || entry.id || entry.mac || entry.clientMac || null;
    const mac = entry.mac || entry.clientMac || entry.client?.mac || null;
    if (!id && !mac) return null;
    const label = entry.clientName || entry.deviceName || entry.description || entry.hostname || entry.client?.description || null;
    const quality = toNumber(entry.signalQuality ?? entry.quality ?? entry.score ?? entry.value);
    const lastSeen = entry.timestamp || entry.lastSeen || entry.observedAt || null;
    const status = entry.status || entry.health || entry.connectionStatus || null;
    const ssid = entry.ssid || entry.ssidName || entry.networkName || entry.ssidId || null;
    return {
      serial: serialKeyOf(serial),
      id: id || mac,
      mac: mac || id || null,
      label,
      signalQuality: quality,
      lastSeen,
      status,
      ssid,
    };
  };

  const summarizeHistory = (samples, deviceEntry) => {
    const normalized = samples.map(normalizeSignalSample).filter(Boolean);
    normalized.sort((a, b) => (a.epochMs || 0) - (b.epochMs || 0));
    const qualities = normalized.map((item) => item.signalQuality).filter((value) => value !== null && value !== undefined);
    const total = qualities.reduce((acc, value) => acc + value, 0);
    const average = qualities.length ? Number((total / qualities.length).toFixed(1)) : null;
    const sortedQualities = qualities.slice().sort((a, b) => a - b);
    let median = null;
    if (sortedQualities.length) {
      const mid = Math.floor(sortedQualities.length / 2);
      if (sortedQualities.length % 2 === 0) {
        median = Number(((sortedQualities[mid - 1] + sortedQualities[mid]) / 2).toFixed(1));
      } else {
        median = sortedQualities[mid];
      }
    }
    const best = qualities.length ? Math.max(...qualities) : null;
    const worst = qualities.length ? Math.min(...qualities) : null;
    const latest = normalized.length ? normalized[normalized.length - 1].signalQuality : null;
    const threshold = 20;
    let microDrops = 0;
    let microDurationMs = 0;
    let lowStart = null;
    normalized.forEach((sample, index) => {
      const quality = sample.signalQuality;
      const status = (sample.status || '').toString().toLowerCase();
      const ts = sample.epochMs ?? null;
      const isLow = (quality !== null && quality !== undefined && quality <= threshold)
        || /poor|bad|critical|down|fail|drop|unstable/.test(status);
      if (isLow) {
        if (lowStart === null) {
          lowStart = ts;
          microDrops += 1;
        }
      } else if (lowStart !== null) {
        const prevTs = normalized[index - 1]?.epochMs ?? lowStart;
        const endTs = ts ?? prevTs;
        if (endTs !== null && lowStart !== null) {
          microDurationMs += Math.max(0, endTs - lowStart);
        }
        lowStart = null;
      }
    });
    if (lowStart !== null) {
      const lastTs = normalized.length ? (normalized[normalized.length - 1].epochMs ?? lowStart) : lowStart;
      microDurationMs += Math.max(0, lastTs - lowStart);
    }

    const deviceSummary = sanitizeDeviceSignalEntry(deviceEntry);

    return {
      average,
      median,
      best,
      worst,
      latest,
      sampleCount: qualities.length,
      microDrops,
      microDurationSeconds: microDurationMs ? Math.round(microDurationMs / 1000) : 0,
      deviceAverage: deviceSummary?.average ?? null,
      deviceMedian: deviceSummary?.median ?? null,
      device: deviceSummary,
      samples: normalized,
    };
  };

  const deviceSignalMap = new Map();
  toArray(signalByDeviceRaw).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const serial = entry.serial || entry.deviceSerial || entry.apSerial || entry.accessPointSerial;
    if (!serial) return;
    registerSerialEntry(deviceSignalMap, serial, entry);
  });

  const historyMap = new Map();
  toArray(signalHistoryRaw).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const serial = entry.serial || entry.deviceSerial || entry.apSerial || entry.accessPointSerial;
    if (!serial) return;
    const samples = extractHistorySamples(entry);
    if (!samples.length) return;
    registerSerialEntry(historyMap, serial, samples);
  });

  const clientsMap = new Map();
  toArray(signalByClientRaw).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const serial = entry.apSerial || entry.deviceSerial || entry.serial || entry.accessPointSerial;
    if (!serial) return;
    pushSerialBucket(clientsMap, serial, entry);
  });

  const failuresMap = new Map();
  const failedConnectionsArray = toArray(failedConnectionsRaw);
  console.debug(`Procesando ${failedConnectionsArray.length} conexiones fallidas (wireless)`);
  
  failedConnectionsArray.forEach((failure) => {
    if (!failure || !failure.serial || !failure.ts) return;
    pushSerialBucket(failuresMap, failure.serial, failure);
  });
  
  console.debug(`FailuresMap: ${failuresMap.size} APs con incidencias (wireless)`);

  const processFailuresToHistory = (failures, timespan = 86400) => {
    if (!Array.isArray(failures) || failures.length === 0) return [];
    
    const bucketSize = 300;
    const now = Date.now();
    const startTime = now - (timespan * 1000);
    const numBuckets = Math.floor(timespan / bucketSize);
    
    const buckets = Array(numBuckets).fill(0).map((_, i) => {
      const bucketStart = startTime + (i * bucketSize * 1000);
      return {
        ts: new Date(bucketStart).toISOString(),
        epochMs: bucketStart,
        signalQuality: 100,
        failures: 0
      };
    });
    
    failures.forEach(failure => {
      const failureTime = new Date(failure.ts).getTime();
      if (failureTime < startTime || failureTime > now) return;
      
      const bucketIndex = Math.floor((failureTime - startTime) / (bucketSize * 1000));
      if (bucketIndex >= 0 && bucketIndex < buckets.length) {
        buckets[bucketIndex].failures++;
        if (buckets[bucketIndex].failures > 0) {
          buckets[bucketIndex].signalQuality = 0;
        }
      }
    });
    
    return buckets;
  };

  let networkSummary = null;
  const networkEntries = toArray(signalByNetworkRaw);
  if (networkEntries.length) {
    const match = networkEntries.find((item) => {
      const candidates = [
        item?.networkId,
        item?.network_id,
        item?.id,
        item?.network?.id,
        item?.network?.networkId,
      ]
        .filter(Boolean)
        .map((value) => value.toString());
      return candidates.includes((networkId || '').toString());
    });

    if (match) {
      networkSummary = {
        average: toNumber(match.averageSignalQuality ?? match.signalQuality ?? match.average ?? match.avg ?? match.mean),
        median: toNumber(match.medianSignalQuality ?? match.median ?? null),
        min: toNumber(match.minSignalQuality ?? match.min ?? match.minimum),
        max: toNumber(match.maxSignalQuality ?? match.max ?? match.maximum),
        coverage: toNumber(match.coverage ?? match.coveragePercentage ?? match.percentCoverage),
        sampleCount: toNumber(match.sampleCount ?? match.samples ?? match.count ?? match.totalMeasurements ?? match.measurements),
        updatedAt: match.lastReportedAt || match.timestamp || match.lastSeen || match.observedAt || match.updatedAt || null,
      };
    }
  }

  const wirelessDevices = accessPoints.map((ap) => {
    const serialKey = serialKeyOf(ap.serial);
    const deviceEntry = deviceSignalMap.get(serialKey) || deviceSignalMap.get(ap.serial?.replace(/-/g, ''));
    const historySamples = historyMap.get(serialKey);
    const summary = historySamples ? summarizeHistory(Array.isArray(historySamples) ? historySamples : [], deviceEntry) : null;
    const failedConnections = failuresMap.get(serialKey);
    const failureHistory = processFailuresToHistory(failedConnections, timespanSeconds || DEFAULT_WIRELESS_TIMESPAN);
    return {
      serial: ap.serial,
      name: ap.name,
      model: ap.model,
      mac: ap.mac,
      status: ap.status,
      lanIp: ap.lanIp,
      tags: ap.tags,
      lastReportedAt: deviceEntry?.lastReportedAt || deviceEntry?.timestamp || deviceEntry?.lastSeen || null,
      signalSummary: summary,
      history: summary?.samples,
      microDrops: summary?.microDrops,
      microDurationSeconds: summary?.microDurationSeconds,
      deviceAggregate: summary?.device,
      failedConnections,
      failureHistory,
      clients: (clientsMap.get(serialKey) || []).map(normalizeClientSignal).filter(Boolean),
    };
  });

  return {
    summary: networkSummary,
    devices: wirelessDevices,
    lastUpdated: networkSummary?.updatedAt || (wirelessDevices[0]?.signalSummary?.samples?.slice(-1)[0]?.ts) || null,
    stats: {
      totalDevices: wirelessDevices.length,
      withIssues: wirelessDevices.filter((device) => {
        const latest = device.signalSummary?.latest;
        if (!latest && !device.failureHistory?.length) return false;
        const isLow = latest && Number.isFinite(latest.signalQuality) && latest.signalQuality <= 30;
        const hasFailures = device.failureHistory?.some((entry) => entry.failures > 0);
        return isLow || hasFailures;
      }).length,
    },
  };
}

module.exports = {
  DEFAULT_WIRELESS_TIMESPAN,
  composeWirelessMetrics,
};
