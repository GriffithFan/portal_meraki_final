// Sistema de Warm Cache para pre-cargar predios frecuentes
const { findPredio, searchPredios } = require('./prediosManager');
const { getNetworkInfo, getNetworkDevices, getOrganizationDevicesStatuses, getNetworkSwitchPortsStatuses } = require('./merakiApi');
const { logger } = require('./config/logger');

// Lista de códigos de predios más frecuentes (actualizar según uso real)
const FREQUENT_PREDIOS = [
  '603005', '600006', // Ajustar según logs de uso real
];

// Obtener top N predios más usados dinámicamente
const WARM_CACHE_SIZE = parseInt(process.env.WARM_CACHE_SIZE || '20');

// Función para pre-cargar un predio completo
async function warmUpPredio(predioCode, cache) {
  try {
    const predioInfo = findPredio(predioCode);
    if (!predioInfo || !predioInfo.network_id) {
      return;
    }

    const networkId = predioInfo.network_id;
    
    // 1. Obtener info básica del network
    const net = await getNetworkInfo(networkId);
    const orgId = net.organizationId;
    
    // Guardar en caché de networks
    cache.networkById.set(networkId, { data: net, exp: Date.now() + (10 * 60 * 1000) });
    
    // 2. Cargar dispositivos y estados en paralelo
    const [devicesRes, statusesRes, portsRes] = await Promise.allSettled([
      getNetworkDevices(networkId),
      getOrganizationDevicesStatuses(orgId, { perPage: 1000, 'networkIds[]': networkId }),
      getNetworkSwitchPortsStatuses(networkId)
    ]);

    const devices = devicesRes.status === 'fulfilled' ? devicesRes.value : [];
    const statuses = statusesRes.status === 'fulfilled' ? statusesRes.value : [];
    const ports = portsRes.status === 'fulfilled' ? portsRes.value : [];

    // 3. Preparar caché de switches
    const statusMap = new Map();
    statuses.forEach(s => statusMap.set(s.serial, s.status || s.reachability));

    const switches = devices.filter(d => (d.model||'').toLowerCase().startsWith('ms'));
    const enrichedSwitches = switches.map(sw => {
      const switchPorts = ports.filter(p => p.serial === sw.serial);
      return {
        ...sw,
        status: statusMap.get(sw.serial) || sw.status,
        totalPorts: switchPorts.length,
        activePorts: switchPorts.filter(p => p.enabled && p.status === 'Connected').length
      };
    });
    cache.switchPorts.set(`${networkId}_switches`, { 
      data: enrichedSwitches, 
      exp: Date.now() + (2 * 60 * 1000) 
    });

    // 4. Preparar caché de access points
    const aps = devices.filter(d => (d.model||'').toLowerCase().startsWith('mr'));
    const enrichedAPs = aps.map(ap => ({
      ...ap,
      status: statusMap.get(ap.serial) || ap.status,
      wiredSpeed: '-',  // Mostrar '-' hasta obtener datos reales
      connectedTo: '-'
    }));
    cache.switchPorts.set(`${networkId}_access_points`, { 
      data: enrichedAPs, 
      exp: Date.now() + (2 * 60 * 1000) 
    });

    // 5. Preparar caché de appliance
    const mx = devices.find(d => (d.model||'').toLowerCase().startsWith('mx'));
    if (mx) {
      const applianceData = {
        device: {
          serial: mx.serial,
          mac: mx.mac,
          model: mx.model,
          name: mx.name,
          networkId: networkId,
          status: statusMap.get(mx.serial) || mx.status || 'online'
        },
        uplinks: [{
          interface: 'WAN 1',
          status: mx.status || 'online',
          ip: mx.wan1Ip || mx.lanIp || 'N/A',
          publicIp: mx.publicIp || 'N/A'
        }],
        lastUpdated: new Date().toISOString()
      };
      cache.applianceStatus.set(`${networkId}_appliance_complete`, { 
        data: [applianceData], 
        exp: Date.now() + (1 * 60 * 1000) 
      });
    }

  } catch (error) {
    logger.error(`Error en la precarga del predio ${predioCode}: ${error.message}`);
  }
}

async function warmUpFrequentPredios(cache) {
  const startTime = Date.now();
  
  // Pre-cargar en batches de 3 para no saturar la API
  const BATCH_SIZE = 3;
  for (let i = 0; i < FREQUENT_PREDIOS.length; i += BATCH_SIZE) {
    const batch = FREQUENT_PREDIOS.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(code => warmUpPredio(code, cache)));
    
    // Pausa de 1 segundo entre batches para respetar rate limits
    if (i + BATCH_SIZE < FREQUENT_PREDIOS.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Función para obtener predios más usados desde un log (futuro)
function getTopPredios(limit = 50) {
  // Por ahora devolver los predios activos más grandes
  try {
    const all = searchPredios({ estado: 'activo' });
    return all.slice(0, limit).map(p => p.predio_code);
  } catch {
    return FREQUENT_PREDIOS;
  }
}

module.exports = {
  warmUpPredio,
  warmUpFrequentPredios,
  getTopPredios,
  FREQUENT_PREDIOS
};
