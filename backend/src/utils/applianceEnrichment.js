/**
 * Appliance Port Enrichment Utilities
 * 
 * Funciones para enriquecer datos de puertos de appliances con información
 * de conectividad de switches y access points.
 * 
 * @module utils/applianceEnrichment
 */

const logger = console; // Usar console como fallback si no hay logger disponible

/**
 * Enriquece puertos de appliance con información de conectividad de switches/APs
 * basándose en topología y datos LLDP.
 * 
 * @param {Array} ports - Array de puertos del appliance
 * @param {Object} options - Opciones de enriquecimiento
 * @param {string} options.applianceSerial - Serial del appliance
 * @param {string} options.applianceModel - Modelo del appliance
 * @param {Object} options.topology - Datos de topología de red
 * @param {Array} options.switchesDetailed - Array de switches con datos detallados
 * @param {Array} options.accessPoints - Array de access points
 * @param {Object} options.logger - Logger personalizado (opcional)
 * @returns {Array} Puertos enriquecidos con información de conectividad
 */
function enrichAppliancePortsWithSwitchConnectivity(
  ports = [],
  {
    applianceSerial = null,
    applianceModel = null,
    topology = {},
    switchesDetailed = [],
    accessPoints = [],
    logger: customLogger = null
  } = {}
) {
  const log = customLogger || logger;
  
  if (!Array.isArray(ports) || !ports.length) return ports;
  
  const serialUpper = (applianceSerial || '').toString().toUpperCase();
  if (!serialUpper) return ports;

  const portConnectivity = new Map();

  // STEP 1: Use uplinkPortOnRemote data from switches (incluye LLDP o inferencia por modelo)
  if (Array.isArray(switchesDetailed)) {
    switchesDetailed.forEach((switchInfo) => {
      if (!switchInfo.uplinkPortOnRemote) return;
      
      const switchName = switchInfo.name || switchInfo.serial;
      const appliancePort = switchInfo.uplinkPortOnRemote;
      
      // Detectar método de detección (lldp o model-inference)
      const detectionMethod = switchInfo.detectionMethod || 'unknown';
      
      // Buscar puerto activo del switch si está disponible
      const uplinkPorts = switchInfo.stats?.uplinkPorts || [];
      const activeUplinkPort = uplinkPorts.find((port) => {
        const portStatus = (port.statusNormalized || port.status || '').toLowerCase();
        return portStatus === 'connected' || portStatus === 'online' || portStatus.includes('active');
      });
      
      const switchPortNumber = activeUplinkPort ? (activeUplinkPort.portId || activeUplinkPort.number) : '-';
      
      portConnectivity.set(appliancePort.toString(), {
        deviceSerial: switchInfo.serial,
        devicePort: switchPortNumber,
        deviceName: switchName,
        deviceType: 'switch',
        _sourceMethod: detectionMethod,
      });
      
      if (log.info) {
        log.info(`Puerto ${appliancePort} del appliance conectado a ${switchName} (${detectionMethod})`);
      }
    });
  }

  // STEP 2: Detect APs connected directly to appliance (GAP networks with Z3)
  const modelUpper = (applianceModel || '').toString().trim().toUpperCase();
  const isZ3 = modelUpper.startsWith('Z3') || modelUpper.startsWith('Z4');
  
  if (isZ3 && Array.isArray(accessPoints) && accessPoints.length > 0) {
    const isGAP = accessPoints.length === 1 && (!switchesDetailed || switchesDetailed.length === 0);
    
    accessPoints.forEach((ap) => {
      const connectedTo = ap.connectedTo || '';
      let connectedPort = ap.connectedPort || '';
      
      if (!connectedPort || connectedPort === '-') {
        const portMatch = connectedTo.match(/\/\s*(?:Port\s*)?(\d+)$/i);
        if (portMatch) {
          connectedPort = portMatch[1];
        }
      }
      
      const isConnectedToSwitch = /\b(SW|MS|Switch)\b/i.test(connectedTo);
      
      if (!isConnectedToSwitch && connectedPort && connectedPort !== '-') {
        let apPortOnZ3 = connectedPort.match(/(\d+)(?:\/\d+)*$/) ? 
                         connectedPort.match(/(\d+)(?:\/\d+)*$/)[1] : 
                         connectedPort;
        
        // Regla GAP: AP conectado en puerto 5 del Z3
        if (isGAP) {
          apPortOnZ3 = '5';
        }
        
        if (apPortOnZ3) {
          const apName = ap.name || ap.model || ap.serial;
          
          portConnectivity.set(apPortOnZ3.toString(), {
            deviceSerial: ap.serial,
            devicePort: '-',
            deviceName: apName,
            deviceType: 'ap',
            _sourceMethod: isGAP ? 'gap-rule-port5' : 'lldp-ap-processed',
          });
        }
      }
    });
  }

  if (!portConnectivity.size) {
    return ports;
  }

  // Enrich ports with connectivity info
  const enrichedPorts = ports.map((port) => {
    if (!port) return port;

    const portKey = (port.number || port.portId || port.name || '').toString();
    const connectivity = portConnectivity.get(portKey);

    if (connectivity) {
      const portInfo = connectivity.deviceType === 'ap' ? '' : ` / Puerto ${connectivity.devicePort}`;
      
      return {
        ...port,
        connectedTo: `${connectivity.deviceName}${portInfo}`,
        connectedDevice: connectivity.deviceSerial,
        connectedDevicePort: connectivity.devicePort,
        connectedDeviceType: connectivity.deviceType,
        statusNormalized: 'connected',
        status: 'active',
        hasCarrier: true,
        _connectivitySource: connectivity._sourceMethod,
        tooltipInfo: {
          type: connectivity.deviceType === 'ap' ? 'lan-ap-connection' : 'lan-switch-connection',
          deviceName: connectivity.deviceName,
          deviceSerial: connectivity.deviceSerial,
          devicePort: connectivity.devicePort,
          deviceType: connectivity.deviceType,
          appliancePort: portKey,
          detectionMethod: connectivity._sourceMethod,
          status: 'connected'
        }
      };
    }

    return port;
  });

  return enrichedPorts;
}

/**
 * Enriquece uplinks de appliance con mapeo de puertos de switch
 * 
 * @param {Array} uplinks - Array de uplinks del appliance
 * @param {Object} options - Opciones de enriquecimiento
 * @param {Array} options.switchPorts - Array de puertos de switch
 * @param {string} options.applianceSerial - Serial del appliance
 * @param {string} options.applianceModel - Modelo del appliance
 * @returns {Array} Uplinks enriquecidos
 */
function enrichApplianceUplinksWithPortMapping(
  uplinks = [],
  { switchPorts = [], applianceSerial = null, applianceModel = null } = {}
) {
  if (!Array.isArray(uplinks) || !uplinks.length) return uplinks;
  if (!Array.isArray(switchPorts) || !switchPorts.length) return uplinks;

  const serialUpper = (applianceSerial || '').toString().toUpperCase();

  // Crear mapa de puertos de switch conectados a este appliance
  const connectedPorts = new Map();
  
  switchPorts.forEach((port) => {
    const lldpSerial = (port.lldpNeighbor?.serial || '').toUpperCase();
    const cdpSerial = (port.cdpNeighbor?.serial || '').toUpperCase();
    
    if (lldpSerial === serialUpper || cdpSerial === serialUpper) {
      const neighborPort = port.lldpNeighbor?.port || port.cdpNeighbor?.port || '';
      const portMatch = neighborPort.match(/(\d+)$/);
      if (portMatch) {
        const appliancePort = portMatch[1];
        connectedPorts.set(appliancePort, {
          switchPort: port.portId || port.number,
          switchSerial: port.switchSerial,
          switchName: port.switchName,
          speed: port.speed,
          duplex: port.duplex
        });
      }
    }
  });

  if (!connectedPorts.size) return uplinks;

  // Enriquecer uplinks con información de conexión
  return uplinks.map((uplink) => {
    const uplinkInterface = (uplink.interface || '').toString();
    const portMatch = uplinkInterface.match(/(\d+)$/);
    
    if (portMatch) {
      const portNum = portMatch[1];
      const connection = connectedPorts.get(portNum);
      
      if (connection) {
        return {
          ...uplink,
          connectedToSwitch: connection.switchName,
          connectedToPort: connection.switchPort,
          detectedSpeed: connection.speed,
          detectedDuplex: connection.duplex,
          _portMappingSource: 'lldp-switch'
        };
      }
    }
    
    return uplink;
  });
}

/**
 * Construye información de tooltips para puertos de appliance
 * 
 * @param {Object} port - Puerto del appliance
 * @param {Object} connectivity - Información de conectividad
 * @returns {Object} Información de tooltip
 */
function buildPortTooltipInfo(port, connectivity) {
  if (!port || !connectivity) return null;
  
  const portKey = (port.number || port.portId || port.name || '').toString();
  
  return {
    type: connectivity.deviceType === 'ap' ? 'lan-ap-connection' : 'lan-switch-connection',
    deviceName: connectivity.deviceName,
    deviceSerial: connectivity.deviceSerial,
    devicePort: connectivity.devicePort,
    deviceType: connectivity.deviceType,
    appliancePort: portKey,
    detectionMethod: connectivity._sourceMethod || 'unknown',
    status: 'connected'
  };
}

module.exports = {
  enrichAppliancePortsWithSwitchConnectivity,
  enrichApplianceUplinksWithPortMapping,
  buildPortTooltipInfo
};
