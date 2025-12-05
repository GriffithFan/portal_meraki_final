// Controlador de networks - gestión de redes, topología, dispositivos
const { logger } = require('../config/logger');
const {
  getNetworkInfo,
  getOrganizations,
  getNetworks,
  getNetworkDevices,
  getOrganizationDevicesStatuses,
  getNetworkTopology_LinkLayer,
  getNetworkSwitchPortsStatuses,
  getNetworkSwitchAccessControlLists,
  getDeviceSwitchPorts,
  getDeviceLldpCdp,
  getNetworkWirelessConnectionStats,
  getDeviceWirelessConnectionStats,
  getOrgWirelessSignalQualityByDevice,
  getNetworkWirelessSignalQualityHistory,
  getNetworkWirelessFailedConnections,
  getOrgSwitchPortsTopologyDiscoveryByDevice,
  getNetworkApplianceConnectivityMonitoringDestinations,
  getOrgApplianceUplinkStatuses,
  getDeviceAppliancePerformance,
  getNetworkApplianceUplinksUsageHistory,
  getOrgDevicesUplinksLossAndLatency,
  getNetworkWirelessSSIDs,
  getNetworkWirelessSSID,
  getOrgWirelessDevicesEthernetStatuses
} = require('../merakiApi');

const { 
  findPredio, 
  getPredioInfoForNetwork 
} = require('../prediosManager');

const {
  toGraphFromLinkLayer,
  toGraphFromDiscoveryByDevice,
} = require('../transformers');

const { logger } = require('../config/logger');

// Caché y utilidades (importar desde servidor.js o mover a un módulo compartido)
const { cache, getFromCache, setInCache } = require('../warmCache');
const { getNetworkSummary: getNetworkSummaryHandler } = require('./networkSummaryController');

const DEFAULT_WIRELESS_TIMESPAN = 3600; // 1 hora

/**
 * Resolver organización de un network
 */
async function resolveNetworkOrgId(networkId) {
  try {
    const cachedNet = getFromCache(cache.networkById, networkId);
    if (cachedNet && cachedNet.organizationId) return cachedNet.organizationId;

    const predioInfo = getPredioInfoForNetwork(networkId);
    if (predioInfo && predioInfo.organization_id) return predioInfo.organization_id;

    const net = await getNetworkInfo(networkId);
    if (!getFromCache(cache.networkById, networkId)) setInCache(cache.networkById, networkId, net);
    if (net.organizationId) return net.organizationId;
  } catch (e) {
    logger.error(`Error resolviendo orgId para ${networkId} (fase 1): ${e.message}`);
  }

  try {
    const orgs = await getOrganizations();
    for (const org of orgs) {
      const cachedNets = getFromCache(cache.networksByOrg, org.id);
      const nets = cachedNets || await getNetworks(org.id);
      if (!cachedNets) setInCache(cache.networksByOrg, org.id, nets);
      if (nets.find(n => n.id === networkId)) return org.id;
    }
  } catch (e) {
    logger.error(`Error resolviendo orgId para ${networkId} (fase 2): ${e.message}`);
  }
  
  return null;
}

/**
 * Buscar networks con filtros
 */
exports.searchNetworks = async (req, res) => {
  try {
    const qRaw = (req.query.q || '').toString().trim();
    if (!qRaw) return res.json([]);
    const q = qRaw.toLowerCase();

    // Fast path: si es un ID de network, devolverlo directo
    if (/^L_\d+$/.test(qRaw)) {
      const cached = getFromCache(cache.networkById, qRaw);
      if (cached) return res.json([cached]);
      try {
        const net = await getNetworkInfo(qRaw);
        setInCache(cache.networkById, qRaw, net);
        return res.json([net]);
      } catch {}
    }

    const orgIdEnv = process.env.MERAKI_ORG_ID;
    let orgs = [];
    if (orgIdEnv) {
      orgs = [{ id: orgIdEnv, name: '' }];
    } else {
      try {
        orgs = await getOrganizations();
      } catch (e) {
        logger.error('Error getOrganizations en /networks/search:', { status: e.response?.status, data: e.response?.data || e.message });
        return res.status(502).json({ error: 'La API key no permite listar organizaciones. Define MERAKI_ORG_ID en .env o usa un ID de network exacto (L_...).' });
      }
    }
    
    const results = [];
    for (const org of orgs) {
      const cached = getFromCache(cache.networksByOrg, org.id);
      const nets = cached || await getNetworks(org.id);
      if (!cached) setInCache(cache.networksByOrg, org.id, nets);
      const filtered = nets.filter(n => `${n.name} ${n.id} ${n.productTypes?.join(' ')} ${n.tags?.join(' ')}`.toLowerCase().includes(q));
      for (const n of filtered) results.push({ ...n, orgId: org.id, orgName: org.name });
    }
    
    res.json(results.slice(0, 20));
  } catch (error) {
    logger.error('Error /api/networks/search', { status: error.response?.status, data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error buscando redes' });
  }
};

/**
 * Resolver predio (por código, número o nombre parcial) optimizado con CSV y caché
 */
exports.resolveNetwork = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Parámetro q requerido' });
    
    const qRaw = q.toString().trim();
    if (!qRaw) return res.status(400).json({ error: 'Parámetro q requerido' });
    if (qRaw === 'NETWORK_ID') {
      return res.status(400).json({ error: 'Reemplaza NETWORK_ID por el ID real (por ej. L_1234567890).' });
    }

    logger.info(`Buscando predio: ${qRaw}`);
    const startTime = Date.now();

    const triggerWarmup = (networkId, orgId) => {
      if (!networkId || !orgId) return;
      setImmediate(async () => {
        try {
          await Promise.allSettled([
            getNetworkDevices(networkId),
            getOrganizationDevicesStatuses(orgId, { perPage: 1000, 'networkIds[]': networkId }),
            getNetworkSwitchPortsStatuses(networkId)
          ]);
        } catch (backgroundError) {
          logger.warn(`Error precargando datos para ${networkId}:`, { error: backgroundError.message });
        }
      });
    };

    const respondAndWarm = ({ network, organization, predio, source, cached }) => {
      if (network?.id && (organization?.id || network.organizationId)) {
        triggerWarmup(network.id, organization?.id || network.organizationId);
      }

      return res.json({
        source: source || 'unknown',
        cached: Boolean(cached),
        elapsedMs: Date.now() - startTime,
        predio: predio || null,
        organization: organization || (network?.organizationId ? { id: network.organizationId } : null),
        network,
      });
    };

    // 1. Intentar resolver por CSV (código de predio o network_id) - INSTANTÁNEO
    const predioInfo = findPredio(qRaw);
    if (predioInfo && predioInfo.network_id) {
      logger.info(`Predio encontrado en CSV: ${predioInfo.network_id} (${Date.now() - startTime}ms)`);
      
      const networkFromCSV = {
        id: predioInfo.network_id,
        name: predioInfo.predio_name || predioInfo.network_name || qRaw,
        organizationId: predioInfo.organization_id || null,
        timeZone: predioInfo.timezone || 'America/Mexico_City',
        tags: predioInfo.tags ? predioInfo.tags.split('|') : [],
        productTypes: predioInfo.product_types ? predioInfo.product_types.split(',') : ['wireless', 'appliance', 'switch'],
      };

      const organizationPayload = {
        id: predioInfo.organization_id || null,
        name: predioInfo.organization_name || predioInfo.organization || 'Organización',
      };

      triggerWarmup(predioInfo.network_id, predioInfo.organization_id);

      logger.info(`Respuesta instantánea desde CSV (${Date.now() - startTime}ms)`);
      return res.json({
        source: 'csv-instant',
        cached: true,
        elapsedMs: Date.now() - startTime,
        predio: predioInfo,
        organization: organizationPayload,
        network: networkFromCSV,
      });
    }

    // 2. Si es un network ID directo, intentar obtenerlo via API
    if (/^L_\d+$/i.test(qRaw)) {
      try {
        const cachedNetwork = getFromCache(cache.networkById, qRaw, 'networks');
        const network = cachedNetwork || await getNetworkInfo(qRaw);
        if (!cachedNetwork) setInCache(cache.networkById, qRaw, network, 'networks');
        
        const predio = findPredio(qRaw);
        const organizationPayload = network?.organizationId ? { id: network.organizationId } : null;
        
        return respondAndWarm({
          network,
          organization: organizationPayload,
          predio,
          source: 'network-id',
          cached: Boolean(cachedNetwork),
        });
      } catch (netErr) {
        logger.warn(`No se pudo resolver network ${qRaw} directamente:`, { error: netErr.message });
      }
    }

    // 3. Buscar por coincidencia exacta de nombre en catálogo CSV
    if (predioInfo) {
      try {
        const targetNetworkId = predioInfo.network_id;
        if (targetNetworkId) {
          const cachedNetwork = getFromCache(cache.networkById, targetNetworkId, 'networks');
          const network = cachedNetwork || await getNetworkInfo(targetNetworkId);
          if (!cachedNetwork) setInCache(cache.networkById, targetNetworkId, network, 'networks');
          
          const organizationPayload = {
            id: network?.organizationId || predioInfo.organization_id || null,
            name: predioInfo.organization_name || predioInfo.organization || null,
          };
          
          return respondAndWarm({
            network,
            organization: organizationPayload,
            predio: predioInfo,
            source: 'csv-partial',
            cached: Boolean(cachedNetwork),
          });
        }
      } catch (csvErr) {
        logger.warn(`No se pudo obtener network para predio ${predioInfo.predio_code}:`, { error: csvErr.message });
      }
    }

    // 4. Fallback: recorrer organizaciones disponibles
    const orgIdEnv = process.env.MERAKI_ORG_ID;
    let orgs = [];
    if (orgIdEnv) {
      orgs = [{ id: orgIdEnv, name: '' }];
    } else {
      try {
        orgs = await getOrganizations();
      } catch (e) {
        logger.error('Error getOrganizations en /resolve-network:', { status: e.response?.status, data: e.response?.data || e.message });
        return res.status(502).json({ error: 'La API key no permite listar organizaciones. Define MERAKI_ORG_ID en .env o usa un ID de network exacto (L_...).' });
      }
    }

    const loweredQuery = qRaw.toLowerCase();
    for (const org of orgs) {
      const cachedNets = getFromCache(cache.networksByOrg, org.id);
      const nets = cachedNets || await getNetworks(org.id);
      if (!cachedNets) setInCache(cache.networksByOrg, org.id, nets);

      const match = nets.find((n) => {
        if (!n) return false;
        if (n.id === qRaw) return true;
        const name = (n.name || '').toLowerCase();
        return name === loweredQuery;
      });

      if (match) {
        return respondAndWarm({
          network: match,
          organization: org,
          predio: findPredio(match.id),
          source: cachedNets ? 'org-cache' : 'org-scan',
          cached: Boolean(cachedNets),
        });
      }
    }

    return res.status(404).json({ error: 'Predio no encontrado' });
  } catch (error) {
    logger.error('Error /api/resolve-network', { status: error.response?.status, data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error resolviendo predio' });
  }
};

/**
 * Carga por sección (lazy loading)
 * Secciones: topology, switches, access_points
 */
exports.getNetworkSection = async (req, res) => {
  const { networkId, sectionKey } = req.params;
  const { query = {} } = req;
  const startTime = Date.now();
  
  try {
    logger.debug(`Cargando sección '${sectionKey}' para network ${networkId}`);
    
    const uplinkTimespan = Number(query.uplinkTimespan) || 24 * 3600;
    const uplinkResolution = Number(query.uplinkResolution) || 300;
    
    // Obtener datos básicos
    const network = await getNetworkInfo(networkId);
    const orgId = network?.organizationId;
    const devices = await getNetworkDevices(networkId);
    
    const statusMap = new Map();
    const deviceStatuses = await getOrganizationDevicesStatuses(orgId, { 'networkIds[]': networkId });
    deviceStatuses.forEach(status => statusMap.set(status.serial, status));
    
    const switches = devices.filter(d => /^ms/i.test(d.model));
    const accessPoints = devices.filter(d => /^mr/i.test(d.model));
    const mxDevice = devices.find(d => /^mx/i.test(d.model));
    
    let result = { networkId, section: sectionKey };
    
    switch (sectionKey) {
      case 'topology': {
        const rawTopology = await getNetworkTopology_LinkLayer(networkId);
        const topology = toGraphFromLinkLayer(rawTopology, statusMap);
        result.topology = topology;
        result.devices = devices.map(d => ({
          serial: d.serial,
          name: d.name,
          model: d.model,
          mac: d.mac,
          lanIp: d.lanIp,
          status: statusMap.get(d.serial)?.status || d.status
        }));
        break;
      }
      
      case 'switches': {
        const switchPortsRaw = await getNetworkSwitchPortsStatuses(networkId);
        const portsBySerial = {};
        switchPortsRaw.forEach(entry => {
          if (!portsBySerial[entry.serial]) portsBySerial[entry.serial] = [];
          portsBySerial[entry.serial].push(entry);
        });
        
        let switchAcls = { rules: [] };
        try {
          switchAcls = await getNetworkSwitchAccessControlLists(networkId);
        } catch (err) {
          logger.warn('ACLs no disponibles:', { error: err.message });
        }
        
        const detailedPortsMap = {};
        for (const sw of switches) {
          try {
            const ports = await getDeviceSwitchPorts(sw.serial);
            detailedPortsMap[sw.serial] = ports;
          } catch (err) {
            logger.warn(`No se pudo obtener config de puertos para ${sw.serial}`);
            detailedPortsMap[sw.serial] = [];
          }
        }
        
        result.switches = switches.map(sw => {
          const statusPorts = portsBySerial[sw.serial] || [];
          const configPorts = detailedPortsMap[sw.serial] || [];
          
          const portsEnriched = statusPorts.map(statusPort => {
            const configPort = configPorts.find(cp => cp.portId === statusPort.portId) || {};
            return {
              portId: statusPort.portId,
              enabled: statusPort.enabled,
              status: statusPort.status,
              isUplink: statusPort.isUplink,
              errors: statusPort.errors || [],
              warnings: statusPort.warnings || [],
              name: configPort.name || `Port ${statusPort.portId}`,
              type: configPort.type,
              vlan: configPort.vlan,
              allowedVlans: configPort.allowedVlans,
              poeEnabled: configPort.poeEnabled,
              linkNegotiation: configPort.linkNegotiation,
              tags: configPort.tags || [],
              accessPolicyType: configPort.accessPolicyType,
              stickyMacAllowList: configPort.stickyMacAllowList,
              stpGuard: configPort.stpGuard
            };
          });
          
          return {
            serial: sw.serial,
            name: sw.name,
            model: sw.model,
            status: statusMap.get(sw.serial)?.status || sw.status,
            mac: sw.mac,
            lanIp: sw.lanIp,
            ports: portsEnriched,
            totalPorts: portsEnriched.length,
            uplinkPorts: portsEnriched.filter(p => p.isUplink).length,
            activePorts: portsEnriched.filter(p => p.status === 'Connected').length
          };
        });
        
        if (switchAcls.rules && switchAcls.rules.length > 0) {
          result.accessControlLists = switchAcls.rules.map(rule => ({
            policy: rule.policy,
            ipVersion: rule.ipVersion,
            protocol: rule.protocol,
            srcCidr: rule.srcCidr,
            srcPort: rule.srcPort,
            dstCidr: rule.dstCidr,
            dstPort: rule.dstPort,
            comment: rule.comment,
            vlan: rule.vlan
          }));
        }
        
        break;
      }
      
      case 'access_points': {
        logger.debug('\n========================================');
        logger.debug('PROCESANDO ACCESS POINTS');
        logger.debug('========================================');
        logger.debug(`Devices disponibles: ${devices.length}`);
        logger.debug(`Switches disponibles: ${switches ? switches.length : 'undefined'}`);
        logger.debug(`AccessPoints disponibles: ${accessPoints.length}`);
        
        logger.debug('Procesando puntos de acceso para', networkId);
        
        const lldpSnapshots = {};
        const wirelessStats = {};
        
        logger.debug(`\nTotal de APs recibidos: ${accessPoints.length}`);
        logger.debug('\n=== LISTA COMPLETA DE APs ===');
        accessPoints.forEach((ap, index) => {
          logger.debug(`${index + 1}. Serial: ${ap.serial} | Nombre: ${ap.name || 'Sin nombre'} | Modelo: ${ap.model} | Status: ${ap.status || 'unknown'}`);
        });
        logger.debug('==============================\n');
        
        // Obtener información de puertos de switches para cruzar velocidades
        let switchPortsRaw = [];
        try {
          switchPortsRaw = await getNetworkSwitchPortsStatuses(networkId);
        } catch (err) {
          logger.warn('No se pudo obtener estado de puertos de switches');
        }
        
        // NUEVO: Obtener estado de ethernet de todos los APs wireless desde la organización
        let wirelessEthernetStatuses = [];
        if (orgId) {
          try {
            const params = { 'networkIds[]': networkId };
            wirelessEthernetStatuses = await getOrgWirelessDevicesEthernetStatuses(orgId, params);
            logger.debug(`\n=== WIRELESS ETHERNET STATUSES (${wirelessEthernetStatuses.length}) ===`);
            wirelessEthernetStatuses.forEach(status => {
              logger.debug(`Serial: ${status.serial} | Speed: ${status.speed} | Power: ${status.power}`);
            });
            logger.debug('==========================================\n');
          } catch (err) {
            logger.warn('No se pudo obtener wireless ethernet statuses');
          }
        }
        
        let networkWirelessStats = null;
        try {
          networkWirelessStats = await getNetworkWirelessConnectionStats(networkId, { timespan: 3600 });
        } catch (err) {
          logger.warn('Estadísticas wireless de la red no disponibles');
        }
        
        const cachedLldpMap = getFromCache(cache.lldpByNetwork, networkId, 'lldp') || {};
        for (const ap of accessPoints) {
          try {
            const info = cachedLldpMap[ap.serial] || await getDeviceLldpCdp(ap.serial);
            if (info) lldpSnapshots[ap.serial] = info;
          } catch (err) {
            logger.warn(`LLDP no disponible para ${ap.serial}`);
          }
          
          try {
            const connStats = await getDeviceWirelessConnectionStats(ap.serial, { timespan: 3600 });
            if (connStats) wirelessStats[ap.serial] = connStats;
          } catch (err) {
            logger.warn(`Wireless stats no disponibles para ${ap.serial}`);
          }
        }
        
        result.accessPoints = accessPoints.map(ap => {
          const lldp = lldpSnapshots[ap.serial];
          let port = null;
          let switchName = '';
          let portNum = '';
          
          if (lldp && lldp.ports) {
            const portKeys = Object.keys(lldp.ports);
            for (const key of portKeys) {
              const p = lldp.ports[key];
              if (p.lldp || p.cdp) {
                port = p;
                break;
              }
            }
          }
          
          const stats = wirelessStats[ap.serial];
          
          if (port) {
            const { cdp, lldp: lldpData } = port;
            if (lldpData && lldpData.systemName) {
              const nameParts = lldpData.systemName.split('-').map(p => p.trim());
              switchName = nameParts[nameParts.length - 1] || lldpData.systemName;
              if (lldpData.portId) {
                const portMatch = lldpData.portId.match(/(\d+)(?:\/\d+)*$/);
                portNum = portMatch ? portMatch[1] : lldpData.portId;
              }
            } else if (cdp && cdp.deviceId) {
              const nameParts = cdp.deviceId.split('-').map(p => p.trim());
              switchName = nameParts[nameParts.length - 1] || cdp.deviceId;
              if (cdp.portId) {
                const portMatch = cdp.portId.match(/(\d+)(?:\/\d+)*$/);
                portNum = portMatch ? portMatch[1] : cdp.portId;
              }
            }
          }
          
          const connectedTo = (switchName && portNum) ? `${switchName}/Port ${portNum}` : (switchName || '-');
          let wiredSpeed = null; // Mostrar '-' hasta obtener datos reales
          
          // PRIORIDAD 1: Buscar en wireless ethernet statuses (más confiable)
          const ethernetStatus = wirelessEthernetStatuses.find(s => s.serial === ap.serial);
          if (ethernetStatus && ethernetStatus.speed) {
            wiredSpeed = ethernetStatus.speed;
            logger.debug(`[AP ${ap.serial}] Speed from wirelessEthernetStatuses: ${wiredSpeed}`);
          } else {
            // PRIORIDAD 2: Intentar obtener velocidad desde LLDP/CDP del AP
            if (port) {
              const { lldp: lldpData, cdp } = port;
              const portSpeed = lldpData?.portSpeed || cdp?.portSpeed || '';
              
              // Solo asignar si hay dato real de velocidad en LLDP/CDP
              if (portSpeed && portSpeed.includes('10000')) {
                wiredSpeed = '10000 Mbps';
              } else if (portSpeed && portSpeed.includes('1000')) {
                wiredSpeed = '1000 Mbps';
              } else if (portSpeed && /\b100\b/.test(portSpeed)) {
                wiredSpeed = '100 Mbps';
              }
              // NO inferir velocidad desde modelo de switch - dejamos null para mostrar '-'
            }
            
            // PRIORIDAD 3: Si aún es null, buscar en puertos del switch
            if (!wiredSpeed && switchName && portNum) {
              const targetSwitch = switches.find(sw => 
                sw.name?.includes(switchName) || sw.serial === switchName
              );
              
              if (targetSwitch) {
                const switchPort = switchPortsRaw.find(p => 
                  p.serial === targetSwitch.serial && p.portId === portNum
                );
                
                if (switchPort) {
                  const linkSpeed = switchPort.linkSpeed || switchPort.speed;
                  if (linkSpeed) {
                    if (typeof linkSpeed === 'number') {
                      wiredSpeed = `${linkSpeed} Mbps`;
                    } else if (typeof linkSpeed === 'string') {
                      wiredSpeed = linkSpeed.includes('Mbps') ? linkSpeed : `${linkSpeed} Mbps`;
                    }
                  }
                  logger.debug(`[AP ${ap.serial}] Speed from switch port: ${wiredSpeed}`);
                }
              }
            }
          }
          
          const tooltipInfo = {
            type: 'access-point',
            name: ap.name || ap.serial,
            model: ap.model,
            serial: ap.serial,
            mac: ap.mac,
            firmware: ap.firmware,
            lanIp: ap.lanIp,
            status: statusMap.get(ap.serial)?.status || ap.status,
            signalQuality: null,
            clients: null,
            microDrops: 0,
            microDurationSeconds: 0,
            connectedTo,
            wiredPort: port?.cdp?.portId || port?.lldp?.portId || '-',
            wiredSpeed,
            power: ethernetStatus?.power || null
          };

          return {
            serial: ap.serial,
            name: ap.name,
            model: ap.model,
            status: statusMap.get(ap.serial)?.status || ap.status,
            mac: ap.mac,
            lanIp: ap.lanIp,
            connectedTo: connectedTo,
            connectedPort: port?.cdp?.portId || port?.lldp?.portId || '-',
            wiredSpeed: wiredSpeed,
            connectionStats: stats ? {
              assoc: stats.assoc || 0,
              auth: stats.auth || 0,
              dhcp: stats.dhcp || 0,
              dns: stats.dns || 0,
              success: stats.success || 0,
              successRate: stats.success && stats.assoc 
                ? ((stats.success / stats.assoc) * 100).toFixed(1) + '%' 
                : 'N/A'
            } : null,
            tooltipInfo
          };
        });
        
        // CORRECCIÓN GAP: En redes con Z3 + APs sin switches, el AP siempre va en puerto 5 (PoE)
        // Detectar si es configuración GAP
        const hasZ3 = devices.some(d => (d.model || '').toUpperCase().startsWith('Z3'));
        const switchCount = (switches && Array.isArray(switches)) ? switches.length : 0;
        const isGAPConfiguration = hasZ3 && switchCount === 0 && result.accessPoints.length === 1;
        
        logger.debug(`[GAP Detection] hasZ3=${hasZ3}, switchCount=${switchCount}, APcount=${result.accessPoints.length}, isGAP=${isGAPConfiguration}`);
        
        if (isGAPConfiguration) {
          logger.debug('Configuración GAP detectada - corrigiendo puerto del AP a puerto 5 (PoE)');
          result.accessPoints = result.accessPoints.map(ap => {
            // Buscar el nombre del appliance/predio desde connectedTo
            const connectedDevice = ap.connectedTo.split('/')[0].trim();
            logger.debug(`[GAP Fix] AP ${ap.serial}: "${ap.connectedTo}" -> "${connectedDevice}/Port 5"`);
            return {
              ...ap,
              connectedTo: `${connectedDevice}/Port 5`,
              connectedPort: '5',
              _correctedForGAP: true
            };
          });
        }
        
        if (networkWirelessStats) {
          result.networkWirelessStats = {
            assoc: networkWirelessStats.assoc || 0,
            auth: networkWirelessStats.auth || 0,
            dhcp: networkWirelessStats.dhcp || 0,
            dns: networkWirelessStats.dns || 0,
            success: networkWirelessStats.success || 0,
            successRate: networkWirelessStats.success && networkWirelessStats.assoc
              ? ((networkWirelessStats.success / networkWirelessStats.assoc) * 100).toFixed(1) + '%'
              : 'N/A'
          };
        }
        
        // Agregar wireless data completo con failedConnections
        if (accessPoints.length > 0 && orgId) {
          try {
            logger.debug(`Cargando métricas wireless con fallas para ${accessPoints.length} APs`);
            const wirelessParams = { 'networkIds[]': networkId, timespan: DEFAULT_WIRELESS_TIMESPAN };
            const [signalByDevice, signalHistory, failedConnections] = await Promise.allSettled([
              getOrgWirelessSignalQualityByDevice(orgId, wirelessParams),
              getNetworkWirelessSignalQualityHistory(networkId, { timespan: DEFAULT_WIRELESS_TIMESPAN, resolution: 300 }),
              getNetworkWirelessFailedConnections(networkId, { timespan: DEFAULT_WIRELESS_TIMESPAN })
            ]);
            
            logger.debug(`failedConnections - estado: ${failedConnections.status}, longitud: ${failedConnections.status === 'fulfilled' && Array.isArray(failedConnections.value) ? failedConnections.value.length : 'N/A'}`);
            
            if (signalByDevice.status === 'fulfilled') {
              result.wirelessSignalByDevice = signalByDevice.value;
            }
            if (signalHistory.status === 'fulfilled') {
              result.wirelessSignalHistory = signalHistory.value;
            }
            if (failedConnections.status === 'fulfilled') {
              result.wirelessFailedConnections = failedConnections.value;
            }
          } catch (err) {
            logger.warn('Error cargando datos wireless completos:', { error: err.message });
          }
        }
        
        break;
      }
      
      default:
        return res.status(400).json({ error: 'Sección no soportada' });
    }
    
    result.elapsedMs = Date.now() - startTime;
    res.json(result);
    
  } catch (error) {
    logger.error('Error /api/networks/:id/section/:key', { status: error.response?.status, data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error obteniendo sección' });
  }
};

/**
 * Obtener resumen del network (endpoint /summary)
 */
exports.getNetworkSummary = (req, res) => getNetworkSummaryHandler(req, res);

/**
 * Endpoint legacy /:section (compatibilidad)
 */
exports.getNetworkLegacySection = async (req, res) => {
  // TODO: Implementar si es necesario para retrocompatibilidad
  res.status(501).json({ error: 'Endpoint legacy no implementado aún' });
};

/**
 * Topology vía discovery-by-device (fallback alternativo)
 */
exports.getTopologyDiscovery = async (req, res) => {
  try {
    const { networkId } = req.params;
    let orgId;
    
    try {
      const net = await getNetworkInfo(networkId);
      orgId = net.organizationId;
    } catch {}
    
    if (!orgId) return res.status(400).json({ error: 'No se pudo resolver la organización del network' });
    
    const data = await getOrgSwitchPortsTopologyDiscoveryByDevice(orgId);
    const filtered = Array.isArray(data) ? data.filter(d => (d.networkId || d.network)?.toString() === networkId.toString()) : [];
    const graph = toGraphFromDiscoveryByDevice(filtered.length ? filtered : data);
    
    res.json({ raw: filtered.length ? filtered : data, graph });
  } catch (error) {
    logger.error('Error /api/networks/:id/topology_discovery', { data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error obteniendo topología (discovery)' });
  }
};

/**
 * Appliance connectivity monitoring destinations
 */
exports.getApplianceConnectivityMonitoring = async (req, res) => {
  try {
    const { networkId } = req.params;
    const data = await getNetworkApplianceConnectivityMonitoringDestinations(networkId);
    res.json(data);
  } catch (error) {
    logger.error('Error /appliance/connectivityMonitoringDestinations', { data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error obteniendo connectivityMonitoringDestinations' });
  }
};

/**
 * Datos históricos del appliance (connectivity + bandwidth usage)
 */
exports.getApplianceHistorical = async (req, res) => {
  try {
    const { networkId } = req.params;
    const timespan = parseInt(req.query.timespan) || 3600;
    const resolution = parseInt(req.query.resolution) || 300;
    
    logger.info(`[HISTORICAL] Request for network ${networkId}, timespan: ${timespan}s, resolution: ${resolution}s`);
    
    const devices = await getNetworkDevices(networkId);
    // Prefer MX devices but accept Z-family appliances (Z3, Z3C) as appliance devices for historical data
    const mxDevice = devices.find(d => {
      const m = (d.model || '').toString().toLowerCase();
      return m.startsWith('mx') || m.startsWith('z');
    });

    if (!mxDevice) {
      logger.info(`[HISTORICAL] No appliance (MX/Z) device found for network ${networkId}`);
      return res.json({ connectivity: [], uplinkUsage: [] });
    }

    logger.info(`[HISTORICAL] Found appliance device: ${mxDevice.serial} (${mxDevice.model})`);

    const orgId = await resolveNetworkOrgId(networkId);
    if (!orgId) {
      logger.info(`[HISTORICAL] Could not resolve orgId for network ${networkId}`);
      return res.json({ connectivity: [], uplinkUsage: [] });
    }
    
    const orgUplinksRaw = await getOrgApplianceUplinkStatuses(orgId, { 'networkIds[]': networkId });
    logger.info(`[HISTORICAL] Raw uplink data received:`, JSON.stringify(orgUplinksRaw).substring(0, 500));
    
    let uplinks = [];
    if (Array.isArray(orgUplinksRaw)) {
      for (const item of orgUplinksRaw) {
        if (item.serial === mxDevice.serial || item.deviceSerial === mxDevice.serial) {
          if (Array.isArray(item.uplinks)) {
            uplinks = item.uplinks;
          } else {
            uplinks.push(item);
          }
        }
      }
    }
    
    logger.info(`[HISTORICAL] Extracted ${uplinks.length} uplinks for device ${mxDevice.serial}`);
    
    let targetIp = null;
    for (const ifaceName of ['wan1', 'wan2', 'WAN1', 'WAN2']) {
      const uplink = uplinks.find(u => {
        const uInterface = u.interface || u.name || '';
        return uInterface.toLowerCase() === ifaceName.toLowerCase();
      });
      
      if (uplink) {
        targetIp = uplink.publicIp || uplink.publicIP || uplink.ip;
        if (targetIp) {
          logger.info(`[HISTORICAL] Using IP from ${uplink.interface || uplink.name}: ${targetIp}`);
          break;
        }
      }
    }
    
    if (!targetIp) {
      const anyUplink = uplinks.find(u => u.publicIp || u.publicIP || u.ip);
      if (anyUplink) {
        targetIp = anyUplink.publicIp || anyUplink.publicIP || anyUplink.ip;
        logger.info(`[HISTORICAL] Using IP from any uplink (${anyUplink.interface || anyUplink.name}): ${targetIp}`);
      }
    }

    if (!targetIp) {
      logger.info(`[HISTORICAL] No active uplink IP found, will try device performance endpoint`);
    }

    const [devicePerformance, uplinkUsage] = await Promise.allSettled([
      getDeviceAppliancePerformance(mxDevice.serial, { timespan }),
      getNetworkApplianceUplinksUsageHistory(networkId, { timespan, resolution })
    ]);
    
    logger.info(`[HISTORICAL] Device Performance status: ${devicePerformance.status}`);
    logger.info(`[HISTORICAL] Uplink Usage status: ${uplinkUsage.status}, points: ${uplinkUsage.value?.length || 0}`);

    let connectivityData = [];
    if (devicePerformance.status === 'fulfilled' && devicePerformance.value) {
      logger.info(`[HISTORICAL] Performance data keys:`, Object.keys(devicePerformance.value || {}));
      logger.info(`[HISTORICAL] Performance data FULL:`, JSON.stringify(devicePerformance.value, null, 2));
    }
    
    logger.info(`[HISTORICAL] Trying org-level loss/latency`);
    try {
      const lossLatency = await getOrgDevicesUplinksLossAndLatency(orgId, { 
        networkIds: [networkId],
        timespan,
        resolution
      });
      
      if (lossLatency && Array.isArray(lossLatency)) {
        const deviceData = lossLatency.find(d => d.serial === mxDevice.serial);
        if (deviceData && deviceData.timeSeries) {
          connectivityData = deviceData.timeSeries;
          logger.info(`[HISTORICAL] Connectivity data from org endpoint: ${connectivityData.length} points`);
        } else {
          logger.info(`[HISTORICAL] No device data found in org response for serial ${mxDevice.serial}`);
        }
      } else {
        logger.info(`[HISTORICAL] Org endpoint returned non-array or empty:`, typeof lossLatency);
      }
    } catch (err) {
      logger.info(`[HISTORICAL] Org-level loss/latency failed:`, err.message);
    }
    
    // Generar datos simulados si no hay históricos
    if (connectivityData.length === 0 && uplinkUsage.status === 'fulfilled' && uplinkUsage.value && uplinkUsage.value.length > 0) {
      logger.info(`[HISTORICAL] No connectivity data available, generating simulated data based on uplink status`);
      logger.info(`[HISTORICAL] First uplinkUsage point:`, JSON.stringify(uplinkUsage.value[0]));
      
      const activeUplink = uplinks.find(u => u.status === 'active');
      connectivityData = uplinkUsage.value.map(point => ({
        ts: point.ts || point.startTime || point.endTime,
        startTs: point.startTime,
        endTs: point.endTime,
        lossPercent: activeUplink ? 0 : 5,
        latencyMs: activeUplink ? 10 : 100
      }));
      
      logger.info(`[HISTORICAL] Generated ${connectivityData.length} connectivity points from uplink status`);
      logger.info(`[HISTORICAL] First generated connectivity point:`, JSON.stringify(connectivityData[0]));
    }

    // If both connectivity and uplinkUsage are empty, log detailed diagnostics (truncated)
    const uplinkUsageArray = uplinkUsage.status === 'fulfilled' ? (uplinkUsage.value || []) : [];
    if ((!connectivityData || connectivityData.length === 0) && (!uplinkUsageArray || uplinkUsageArray.length === 0)) {
      try {
        logger.info(`[HISTORICAL-DEBUG] Empty historical payload for network ${networkId}, device ${mxDevice?.serial || 'unknown'}`);
        logger.info(`[HISTORICAL-DEBUG] orgId: ${orgId}`);
        logger.info(`[HISTORICAL-DEBUG] uplinks (extracted): ${JSON.stringify(uplinks).substring(0, 1000)}`);
        logger.info(`[HISTORICAL-DEBUG] devicePerformance.status: ${devicePerformance.status}`);
        logger.info(`[HISTORICAL-DEBUG] devicePerformance.value (truncated): ${devicePerformance.status === 'fulfilled' ? JSON.stringify(devicePerformance.value).substring(0, 2000) : 'N/A'}`);
        logger.info(`[HISTORICAL-DEBUG] uplinkUsage.status: ${uplinkUsage.status}`);
        logger.info(`[HISTORICAL-DEBUG] uplinkUsage.value (truncated): ${uplinkUsage.status === 'fulfilled' ? JSON.stringify(uplinkUsage.value).substring(0, 2000) : 'N/A'}`);
      } catch (err) {
        logger.warn('[HISTORICAL-DEBUG] Failed to stringify diagnostic payloads', { error: err.message });
      }
    }

    res.json({
      connectivity: connectivityData,
      uplinkUsage: uplinkUsageArray
    });
  } catch (error) {
    logger.error('[HISTORICAL] Error:', { data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error obteniendo datos historicos del appliance' });
  }
};

/**
 * Wireless SSIDs list
 */
exports.getWirelessSSIDs = async (req, res) => {
  try {
    const { networkId } = req.params;
    const data = await getNetworkWirelessSSIDs(networkId);
    res.json(data);
  } catch (error) {
    logger.error('Error /wireless/ssids', { data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error obteniendo SSIDs' });
  }
};

/**
 * Wireless SSID por número
 */
exports.getWirelessSSID = async (req, res) => {
  try {
    const { networkId, number } = req.params;
    const data = await getNetworkWirelessSSID(networkId, number);
    res.json(data);
  } catch (error) {
    logger.error('Error /wireless/ssids/:number', { data: error.response?.data || error.message });
    res.status(500).json({ error: 'Error obteniendo SSID' });
  }
};

module.exports = {
  resolveNetworkOrgId,
  ...exports
};
