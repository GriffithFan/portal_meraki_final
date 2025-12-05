const axios = require('axios');
const PQueue = require('p-queue').default;
const { logger } = require('./config/logger');

const MERAKI_API_KEY = process.env.MERAKI_API_KEY || '';
const BASE_URL = process.env.MERAKI_BASE_URL || 'https://api.meraki.com/api/v1';

// ========== RATE LIMITING GLOBAL ==========
// Meraki API límite: 5 req/sec por organización (burst hasta 10, luego throttle)
// Configuramos queue conservador: 4 req/sec = 250ms entre requests
const apiQueue = new PQueue({
  interval: 1000,      // 1 segundo
  intervalCap: 4,      // Máximo 4 requests por segundo (margen de seguridad)
  concurrency: 4,      // Máximo 4 requests paralelos
  timeout: 30000,      // Timeout global de 30s por request
  throwOnTimeout: false
});

logger.info('[merakiApi] Rate limiter inicializado: 4 req/sec, concurrencia 4');

// Centralized Meraki API client with retry logic and authentication
const client = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,  // Aumentado de 15s a 20s para predios grandes
  headers: {
    'X-Cisco-Meraki-API-Key': MERAKI_API_KEY,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }
});

// ========== RETRY LOGIC MEJORADO ==========
// Reintentos exponenciales para 429 (rate limit) y errores temporales
async function retryWithBackoff(fn, maxRetries = 4, initialDelay = 800) {
  let lastError;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      
      // Solo reintentar en errores recuperables
      if (status === 429 || status === 503 || status === 502 || !status) {
        const delay = initialDelay * Math.pow(2, attempt);
        logger.warn(`[merakiApi] Error ${status || 'timeout'} (intento ${attempt + 1}/${maxRetries}). Reintentando en ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Errores no recuperables (400, 401, 403, 404) - no reintentar
        throw error;
      }
    }
  }
  throw lastError;
}

// Wrapper para ejecutar requests a través de la queue con reintentos
async function queuedRequest(requestFn) {
  return apiQueue.add(() => retryWithBackoff(requestFn));
}

// Extract pagination cursor from RFC 5988 Link header format
// The Meraki API returns cursors in various header formats depending on endpoint
function parseNextCursor(linkHeader) {
  if (!linkHeader) return null;
  const source = Array.isArray(linkHeader) ? linkHeader.join(',') : linkHeader;
  const segments = source.split(',');
  for (const segment of segments) {
    const [rawUrl, ...rest] = segment.split(';').map((part) => part.trim());
    if (!rawUrl) continue;
    const isNext = rest.some((item) => /rel="?next"?/i.test(item));
    if (!isNext) continue;
    const match = rawUrl.match(/startingAfter=([^&>]+)/i) || rawUrl.match(/starting_after=([^&>]+)/i);
    if (match && match[1]) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return match[1];
      }
    }
  }
  return null;
}

// Check multiple header variations for pagination cursor
// Different Meraki endpoints return pagination info in different ways
function getNextCursorFromHeaders(headers = {}) {
  const direct = headers['x-next-page-starting-after']
    || headers['x-next-starting-after']
    || headers['x-next-page-cursor']
    || headers['x-page-next'];
  if (direct) return direct;
  return parseNextCursor(headers.link || headers.Link);
}

async function fetchAllPages(path, params = {}, { perPage = 1000, maxPages = 100 } = {}) {
  const results = [];
  let cursor = params.startingAfter;
  let page = 0;

  while (page < maxPages) {
    const query = { ...params, perPage };
    if (cursor) query.startingAfter = cursor;

    const response = await client.get(path, { params: query });
    const { data, headers } = response;

    if (Array.isArray(data)) {
      results.push(...data);
    } else if (data && Array.isArray(data.items)) {
      results.push(...data.items);
    } else if (data) {
      results.push(data);
    }

    const nextCursor = getNextCursorFromHeaders(headers);
    if (!nextCursor || nextCursor === cursor) {
      break;
    }
    cursor = nextCursor;
    page += 1;
  }

  return results;
}

if (!MERAKI_API_KEY) {
  // Aviso temprano en logs para evitar confusión cuando falte la API key
  // No lanzamos excepción aquí para que el servidor levante, pero las llamadas a Meraki fallarán con 401/403
  logger.warn('[merakiApi] MERAKI_API_KEY no está configurada en .env. Configúrala para que las llamadas a la API de Meraki funcionen.');
}

async function getOrganizations() {
  const { data } = await client.get('/organizations');
  return data;
}

async function getNetworks(organizationId) {
  return fetchAllPages(`/organizations/${organizationId}/networks`, {}, { perPage: 1000 });
}

async function getNetworkDevices(networkId) {
  const { data } = await client.get(`/networks/${networkId}/devices`);
  return data;
}

async function getNetworkInfo(networkId) {
  const { data } = await client.get(`/networks/${networkId}`);
  return data;
}

async function getNetworkTopology(networkId) {
  // Algunos tenants tienen este endpoint habilitado
  const { data } = await client.get(`/networks/${networkId}/topology`);
  return data;
}

async function getNetworkTopologyLinkLayer(networkId) {
  const { data } = await client.get(`/networks/${networkId}/topology/linkLayer`);
  return data;
}

async function getNetworkTopologyNetworkLayer(networkId) {
  const { data } = await client.get(`/networks/${networkId}/topology/networkLayer`);
  return data;
}

async function getOrganizationDevicesStatuses(organizationId, params = {}) {
  // Permite filtrar por networkIds[] conservando paginación básica
  const { data } = await client.get(`/organizations/${organizationId}/devices/statuses`, {
    params
  });
  return data;
}

async function getOrganizationDevices(organizationId, params = {}) {
  // Obtiene lista completa de dispositivos, soporta filtrado por MAC
  const { data } = await client.get(`/organizations/${organizationId}/devices`, {
    params
  });
  return data;
}

async function getApplianceStatuses(networkId) {
  // Probar plural/singular por diferencias entre tenants o documentación
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/uplinks/statuses`);
    return data;
  } catch (e) {
    if (e.response && e.response.status === 404) {
      logger.warn(`[merakiApi] Fallback: /appliance/uplinks/statuses no encontrado para ${networkId}, intentando /appliance/uplink/statuses`);
      const { data } = await client.get(`/networks/${networkId}/appliance/uplink/statuses`);
      return data;
    }
    // Si el error no es 404, lo relanzamos
    throw e;
  }
}

// Alternativa: estados de uplinks a nivel organización (permite filtrar por networkIds[])
async function getOrgApplianceUplinksStatuses(organizationId, params = {}) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/uplinks/statuses`, { params });
    return data;
  } catch (e) {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/uplink/statuses`, { params });
    return data;
  }
}

async function getOrgTopAppliancesByUtilization(organizationId, params = {}) {
  const { data } = await client.get(`/organizations/${organizationId}/summary/top/appliances/byUtilization`, { params });
  return data;
}

async function getOrgDevicesUplinksAddressesByDevice(organizationId, params = {}) {
  const { data } = await client.get(`/organizations/${organizationId}/devices/uplinks/addresses/byDevice`, { params });
  return data;
}

async function getOrganizationUplinksStatuses(organizationId, params = {}) {
  const { data } = await client.get(`/organizations/${organizationId}/uplinks/statuses`, { params });
  return data;
}

// Extra endpoints shared by user
async function getOrgSwitchPortsTopologyDiscoveryByDevice(organizationId) {
  const { data } = await client.get(`/organizations/${organizationId}/switch/ports/topology/discovery/byDevice`);
  return data;
}

async function getNetworkApplianceConnectivityMonitoringDestinations(networkId) {
  const { data } = await client.get(`/networks/${networkId}/appliance/connectivityMonitoringDestinations`);
  return data;
}

async function getNetworkWirelessSSIDs(networkId) {
  const { data } = await client.get(`/networks/${networkId}/wireless/ssids`);
  return data;
}

async function getNetworkWirelessSSID(networkId, number) {
  const { data } = await client.get(`/networks/${networkId}/wireless/ssids/${number}`);
  return data;
}

async function getOrgWirelessDevicesRadsecAuthorities(organizationId) {
  const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/radsec/certificates/authorities`);
  return data;
}

async function getOrgWirelessSignalQualityByNetwork(organizationId, params = {}) {
  const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/signalQuality/byNetwork`, { params });
  return data;
}

async function getOrgWirelessSignalQualityByDevice(organizationId, params = {}) {
  const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/signalQuality/byDevice`, { params });
  return data;
}

async function getOrgWirelessSignalQualityByClient(organizationId, params = {}) {
  const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/signalQuality/byClient`, { params });
  return data;
}

async function getNetworkWirelessSignalQualityHistory(networkId, params = {}) {
  const { data } = await client.get(`/networks/${networkId}/wireless/signalQualityHistory`, { params });
  return data;
}

async function getDeviceLldpCdp(serial) {
  try {
    const { data } = await client.get(`/devices/${serial}/lldpCdp`);
    return data;
  } catch (e) {
    // Algunos listados utilizan la barra intermedia
    const { data } = await client.get(`/devices/${serial}/lldp/cdp`);
    return data;
  }
}

async function getNetworkSwitchPortsStatuses(networkId) {
  const { data } = await client.get(`/networks/${networkId}/switch/ports/statuses`, { params: { perPage: 1000 } });
  return data;
}

async function getDeviceSwitchPortsStatuses(serial) {
  return fetchAllPages(`/devices/${serial}/switch/ports/statuses`, {}, { perPage: 1000 });
}

// Endpoints adicionales para información detallada del appliance
async function getAppliancePerformance(networkId, timespan = 3600) {
  const { data } = await client.get(`/networks/${networkId}/appliance/performance`, { 
    params: { timespan, resolution: 300 }
  });
  return data;
}

async function getDeviceAppliancePerformance(serial, params = {}) {
  try {
    // Parámetros: t0, t1, timespan
    const { data } = await client.get(`/devices/${serial}/appliance/performance`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching device appliance performance for ${serial}:`, { error: error.message });
    return null;
  }
}

async function getApplianceUplinks(networkId) {
  const { data } = await client.get(`/networks/${networkId}/appliance/uplinks`);
  return data;
}

async function getDeviceUplink(serial) {
  const { data } = await client.get(`/devices/${serial}/uplink`);
  return data;
}

async function getApplianceClientSecurity(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/security/intrusion`);
    return data;
  } catch {
    return null;
  }
}

async function getOrganizationApplianceSecurityIntrusion(organizationId) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/security/intrusion`);
    return data;
  } catch {
    return null;
  }
}

async function getNetworkApplianceSecurityMalware(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/security/malware`);
    return data;
  } catch {
    return null;
  }
}

async function getApplianceTrafficShaping(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/trafficShaping`);
    return data;
  } catch {
    return null;
  }
}

async function getNetworkClientsBandwidthUsage(networkId, timespan = 3600) {
  try {
    const { data } = await client.get(`/networks/${networkId}/clients/bandwidthUsageHistory`, {
      params: { timespan, resolution: 300 }
    });
    return data;
  } catch {
    return [];
  }
}

async function getAppliancePorts(networkId) {
  const { data } = await client.get(`/networks/${networkId}/appliance/ports`);
  return data;
}

async function getDeviceAppliancePortsStatuses(serial) {
  try {
    const { data } = await client.get(`/devices/${serial}/appliance/ports/statuses`);
    return data;
  } catch (error) {
    if (error?.response?.status === 404) {
      logger.warn(`[merakiApi] /devices/${serial}/appliance/ports/statuses no disponible, probando endpoint alternativo`);
      const { data } = await client.get(`/devices/${serial}/appliance/ports/status`);
      return data;
    }
    throw error;
  }
}

async function getOrgApplianceUplinksLossAndLatency(organizationId, params = {}) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/uplinks/lossAndLatency`, { params });
    return data;
  } catch (error) {
    if (error?.response?.status === 404) {
      logger.warn('[merakiApi] Endpoint lossAndLatency no disponible, omitiendo timeseries de conectividad');
      return [];
    }
    throw error;
  }
}

async function getOrgApplianceUplinksUsageByDevice(organizationId, params = {}) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/uplinks/usage/byDevice`, { params });
    return data;
  } catch (error) {
    if (error?.response?.status === 404) {
      logger.warn('[merakiApi] Endpoint usage/byDevice no disponible, omitiendo métricas de uso por uplink');
      return [];
    }
    throw error;
  }
}

async function getDeviceSwitchPorts(serial) {
  const { data } = await client.get(`/devices/${serial}/switch/ports`);
  return data;
}

async function getDeviceSwitchPort(serial, portId) {
  const { data } = await client.get(`/devices/${serial}/switch/ports/${portId}`);
  return data;
}

// Nuevos endpoints para mejorar información de switches
async function getNetworkSwitchAccessControlLists(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/switch/accessControlLists`);
    return data;
  } catch (error) {
    logger.error(`Error fetching switch ACLs for network ${networkId}:`, { error: error.message });
    return { rules: [] };
  }
}

async function getOrgSwitchPortsBySwitch(organizationId) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/switch/ports/bySwitch`, {
      params: { perPage: 1000 }
    });
    return data;
  } catch (error) {
    logger.error(`Error fetching switch ports by switch:`, { error: error.message });
    return [];
  }
}

async function getNetworkSwitchStackRoutingInterfaces(networkId, switchStackId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/switch/stacks/${switchStackId}/routing/interfaces`);
    return data;
  } catch (error) {
    logger.error(`Error fetching switch stack routing interfaces:`, { error: error.message });
    return [];
  }
}

// Nuevos endpoints para mejores métricas de conectividad y wireless
async function getNetworkCellularGatewayConnectivityMonitoringDestinations(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/cellularGateway/connectivityMonitoringDestinations`);
    return data;
  } catch (error) {
    logger.error(`Error fetching cellular gateway connectivity destinations for network ${networkId}:`, { error: error.message });
    return { destinations: [] };
  }
}

async function getDeviceWirelessConnectionStats(serial, params = {}) {
  try {
    return await queuedRequest(async () => {
      const { data } = await client.get(`/devices/${serial}/wireless/connectionStats`, { params });
      return data;
    });
  } catch (error) {
    const status = error.response?.status;
    if (status !== 429) {
      logger.warn(`Error fetching wireless connection stats for device ${serial}: ${error.message}`);
    }
    return null;
  }
}

async function getNetworkWirelessConnectionStats(networkId, params = {}) {
  try {
    // Parámetros opcionales: t0, t1, timespan, band, ssid, vlan, apTag
    const { data } = await client.get(`/networks/${networkId}/wireless/connectionStats`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching network wireless connection stats for ${networkId}:`, { error: error.message });
    return null;
  }
}

async function getNetworkWirelessLatencyStats(networkId, params = {}) {
  try {
    const { data } = await client.get(`/networks/${networkId}/wireless/latencyStats`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching wireless latency stats:`, { error: error.message });
    return null;
  }
}

async function getDeviceWirelessLatencyStats(serial, params = {}) {
  try {
    const { data } = await client.get(`/devices/${serial}/wireless/latencyStats`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching device wireless latency stats:`, { error: error.message });
    return null;
  }
}

async function getNetworkWirelessFailedConnections(networkId, params = {}) {
  try {
    return await queuedRequest(async () => {
      const { data } = await client.get(`/networks/${networkId}/wireless/failedConnections`, { params });
      return data;
    });
  } catch (error) {
    const status = error.response?.status;
    if (status !== 429) {
      logger.warn(`Error fetching wireless failed connections (${networkId}): ${error.message}`);
    }
    return [];
  }
}

// ============================================================================
// NUEVOS ENDPOINTS PARA ENRIQUECIMIENTO DE DATOS
// ============================================================================

async function getDeviceLossAndLatencyHistory(serial, params = {}) {
  try {
    // Parámetros: ip (required), t0, t1, timespan, resolution, uplink
    const { data } = await client.get(`/devices/${serial}/lossAndLatencyHistory`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching loss and latency history for device ${serial}:`, { error: error.message });
    return null;
  }
}

async function getOrgDevicesUplinksLossAndLatency(organizationId, params = {}) {
  try {
    // Parámetros: t0, t1, timespan, uplink, ip
    const { data } = await client.get(`/organizations/${organizationId}/devices/uplinksLossAndLatency`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching org uplinks loss and latency for org ${organizationId}:`, { error: error.message });
    return [];
  }
}

async function getOrgWirelessDevicesPacketLossByClient(organizationId, params = {}) {
  try {
    // Parámetros: networkIds[], serials[], ssids[], bands[], t0, t1, timespan
    const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/packetLoss/byClient`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching wireless packet loss by client:`, { error: error.message });
    return [];
  }
}

async function getOrgWirelessDevicesPacketLossByDevice(organizationId, params = {}) {
  try {
    // Parámetros: networkIds[], serials[], ssids[], bands[], t0, t1, timespan
    const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/packetLoss/byDevice`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching wireless packet loss by device:`, { error: error.message });
    return [];
  }
}

async function getNetworkApplianceConnectivityMonitoringDests(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/connectivityMonitoringDestinations`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance connectivity monitoring destinations:`, { error: error.message });
    return null;
  }
}

async function getNetworkAppliancePortsConfig(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/ports`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance ports config:`, { error: error.message });
    return [];
  }
}

async function getOrgApplianceUplinkStatuses(organizationId, params = {}) {
  try {
    // Parámetros: networkIds[], serials[], iccids[]
    return fetchAllPages(`/organizations/${organizationId}/appliance/uplink/statuses`, params, { perPage: 1000 });
  } catch (error) {
    logger.error(`Error fetching org appliance uplink statuses:`, { error: error.message });
    return [];
  }
}

async function getNetworkApplianceVlans(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/vlans`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance VLANs:`, { error: error.message });
    return [];
  }
}

async function getNetworkApplianceVlan(networkId, vlanId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/vlans/${vlanId}`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance VLAN ${vlanId}:`, { error: error.message });
    return null;
  }
}

async function getNetworkApplianceSettings(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/settings`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance settings:`, { error: error.message });
    return null;
  }
}

async function getOrgApplianceSdwanInternetPolicies(organizationId) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/sdwan/internetPolicies`);
    return data;
  } catch (error) {
    logger.error(`Error fetching SDWAN internet policies:`, { error: error.message });
    return [];
  }
}

async function getOrgUplinksStatuses(organizationId, params = {}) {
  try {
    return fetchAllPages(`/organizations/${organizationId}/uplinks/statuses`, params, { perPage: 1000 });
  } catch (error) {
    logger.error(`Error fetching org uplinks statuses:`, { error: error.message });
    return [];
  }
}

async function getDeviceApplianceUplinksSettings(serial) {
  try {
    const { data } = await client.get(`/devices/${serial}/appliance/uplinks/settings`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance uplinks settings:`, { error: error.message });
    return null;
  }
}

async function getNetworkApplianceTrafficShapingUplinkSelection(networkId) {
  try {
    const { data } = await client.get(`/networks/${networkId}/appliance/trafficShaping/uplinkSelection`);
    return data;
  } catch (error) {
    logger.error(`Error fetching traffic shaping uplink selection:`, { error: error.message });
    return null;
  }
}

async function getOrgApplianceUplinksUsageByNetwork(organizationId, params = {}) {
  try {
    // Parámetros: t0, t1, timespan
    const { data } = await client.get(`/organizations/${organizationId}/appliance/uplinks/usage/byNetwork`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance uplinks usage by network:`, { error: error.message });
    return [];
  }
}

async function getNetworkApplianceUplinksUsageHistory(networkId, params = {}) {
  try {
    // Parámetros: t0, t1, timespan, resolution
    const { data } = await client.get(`/networks/${networkId}/appliance/uplinks/usageHistory`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching network uplinks usage history:`, { error: error.message });
    return [];
  }
}

async function getOrgApplianceUplinksStatusesOverview(organizationId) {
  try {
    const { data } = await client.get(`/organizations/${organizationId}/appliance/uplinks/statuses/overview`);
    return data;
  } catch (error) {
    logger.error(`Error fetching appliance uplinks statuses overview:`, { error: error.message });
    return null;
  }
}

// Nuevo endpoint: Estado de puertos ethernet de APs wireless
// CRÍTICO: Este endpoint falla con 429 en predios grandes, implementar reintentos agresivos
async function getOrgWirelessDevicesEthernetStatuses(organizationId, params = {}) {
  try {
    return await queuedRequest(async () => {
      const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/ethernet/statuses`, { params });
      return data;
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 429) {
      logger.warn(`[merakiApi] Rate limit en ethernet statuses después de ${4} reintentos. Devolviendo array vacío (fallback a LLDP activo).`);
    } else if (status !== 404) {
      logger.warn(`Error fetching wireless devices ethernet statuses: ${error.message}`);
    }
    return [];
  }
}

async function getOrgDevicesAvailabilitiesChangeHistory(organizationId, params = {}) {
  try {
    // Returns history of device availability changes
    // Params: t0, t1, timespan, serials[], productTypes[], networkIds[], perPage, startingAfter, endingBefore
    const { data } = await client.get(`/organizations/${organizationId}/devices/availabilities/changeHistory`, { params });
    return data;
  } catch (error) {
    logger.error(`Error fetching devices availabilities change history:`, { error: error.message });
    return [];
  }
}

// Wireless Controllers by Device para una organización
async function getOrgWirelessControllersByDevice(organizationId) {
  const { data } = await client.get(`/organizations/${organizationId}/wireless/devices/wirelessControllers/byDevice`);
  return data;
}

// Wireless Controller Connections para una organización
async function getOrgWirelessControllerConnections(organizationId) {
  const { data } = await client.get(`/organizations/${organizationId}/wirelessController/connections`);
  return data;
}

module.exports = {
  getOrganizations,
  getNetworks,
  getNetworkDevices,
  getNetworkInfo,
  getNetworkTopology,
  getNetworkTopologyLinkLayer,
  getNetworkTopologyNetworkLayer,
  getApplianceStatuses,
  getOrganizationDevicesStatuses,
  getOrganizationDevices,
  // extras
  getOrgSwitchPortsTopologyDiscoveryByDevice,
  getNetworkApplianceConnectivityMonitoringDestinations,
  getNetworkWirelessSSIDs,
  getNetworkWirelessSSID,
  getOrgWirelessDevicesRadsecAuthorities,
  getOrgWirelessSignalQualityByNetwork,
  getOrgWirelessSignalQualityByDevice,
  getOrgWirelessSignalQualityByClient,
  getDeviceLldpCdp,
  getNetworkSwitchPortsStatuses,
  getDeviceSwitchPortsStatuses,
  getNetworkWirelessSignalQualityHistory,
  getOrgApplianceUplinksStatuses,
  getOrgTopAppliancesByUtilization,
  getOrgDevicesUplinksAddressesByDevice,
  getOrganizationUplinksStatuses,
  // Nuevos endpoints para appliance detallado
  getAppliancePerformance,
  getDeviceAppliancePerformance,
  getApplianceUplinks,
  getDeviceUplink,
  getApplianceClientSecurity,
  getOrganizationApplianceSecurityIntrusion,
  getApplianceTrafficShaping,
  getNetworkClientsBandwidthUsage,
  getNetworkApplianceSecurityMalware,
  // Nuevos endpoints para puertos de appliance
  getAppliancePorts,
  getDeviceAppliancePortsStatuses,
  getOrgApplianceUplinksLossAndLatency,
  getOrgApplianceUplinksUsageByDevice,
  getDeviceSwitchPorts,
  getDeviceSwitchPort,
  // Nuevos endpoints para switches mejorados
  getNetworkSwitchAccessControlLists,
  getOrgSwitchPortsBySwitch,
  getNetworkSwitchStackRoutingInterfaces,
  // Nuevos endpoints para conectividad y wireless mejorados
  getNetworkCellularGatewayConnectivityMonitoringDestinations,
  getDeviceWirelessConnectionStats,
  getNetworkWirelessConnectionStats,
  getNetworkWirelessLatencyStats,
  getDeviceWirelessLatencyStats,
  getNetworkWirelessFailedConnections,
  // Nuevos endpoints para enriquecimiento (Loss & Latency, Packet Loss, etc.)
  getDeviceLossAndLatencyHistory,
  getOrgDevicesUplinksLossAndLatency,
  getOrgWirelessDevicesPacketLossByClient,
  getOrgWirelessDevicesPacketLossByDevice,
  getNetworkApplianceConnectivityMonitoringDests,
  getNetworkAppliancePortsConfig,
  getOrgApplianceUplinkStatuses,
  getNetworkApplianceVlans,
  getNetworkApplianceVlan,
  getNetworkApplianceSettings,
  getOrgApplianceSdwanInternetPolicies,
  getOrgUplinksStatuses,
  getDeviceApplianceUplinksSettings,
  getNetworkApplianceTrafficShapingUplinkSelection,
  getOrgApplianceUplinksUsageByNetwork,
  getNetworkApplianceUplinksUsageHistory,
  getOrgApplianceUplinksStatusesOverview,
  // Wireless ethernet statuses
  getOrgWirelessDevicesEthernetStatuses,
  // Device availabilities
  getOrgDevicesAvailabilitiesChangeHistory,
  // Wireless controllers
  getOrgWirelessControllersByDevice,
  getOrgWirelessControllerConnections
};
