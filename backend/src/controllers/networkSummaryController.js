const { cache, getFromCache, setInCache } = require('../cache/cacheStore');
const { logger } = require('../config/logger');
const { resolveNetworkOrgId } = require('../utils/networkResolver');
const { DEFAULT_WIRELESS_TIMESPAN, composeWirelessMetrics } = require('../utils/wirelessMetrics');
const { toGraphFromLinkLayer, buildTopologyFromLldp } = require('../transformers');
const { getPredioInfoForNetwork } = require('../prediosManager');
const {
  getOrganizations,
  getNetworks,
  getNetworkDevices,
  getNetworkTopology,
  getNetworkTopologyLinkLayer,
  getNetworkTopologyNetworkLayer,
  getApplianceStatuses,
  getOrganizationDevicesStatuses,
  getOrganizationDevices,
  getNetworkInfo,
  getOrgSwitchPortsTopologyDiscoveryByDevice,
  getNetworkApplianceConnectivityMonitoringDestinations,
  getNetworkWirelessSSIDs,
  getNetworkWirelessSSID,
  getOrgWirelessDevicesRadsecAuthorities,
  getOrgWirelessSignalQualityByNetwork,
  getOrgWirelessSignalQualityByDevice,
  getOrgWirelessSignalQualityByClient,
  getNetworkWirelessSignalQualityHistory,
  getDeviceLldpCdp,
  getNetworkSwitchPortsStatuses,
  getDeviceSwitchPortsStatuses,
  getOrgApplianceUplinksStatuses,
  getOrgTopAppliancesByUtilization,
  getOrgDevicesUplinksAddressesByDevice,
  getOrganizationUplinksStatuses,
  getAppliancePerformance,
  getDeviceAppliancePerformance,
  getApplianceUplinks,
  getDeviceUplink,
  getApplianceClientSecurity,
  getOrganizationApplianceSecurityIntrusion,
  getApplianceTrafficShaping,
  getNetworkClientsBandwidthUsage,
  getNetworkApplianceSecurityMalware,
  getAppliancePorts,
  getDeviceAppliancePortsStatuses,
  getOrgApplianceUplinksLossAndLatency,
  getOrgApplianceUplinksUsageByDevice,
  getDeviceSwitchPorts,
  getNetworkSwitchAccessControlLists,
  getOrgSwitchPortsBySwitch,
  getNetworkSwitchStackRoutingInterfaces,
  getNetworkCellularGatewayConnectivityMonitoringDestinations,
  getDeviceWirelessConnectionStats,
  getNetworkWirelessConnectionStats,
  getNetworkWirelessLatencyStats,
  getDeviceWirelessLatencyStats,
  getNetworkWirelessFailedConnections,
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
  getOrgWirelessDevicesEthernetStatuses,
  getOrgDevicesAvailabilitiesChangeHistory
} = require('../merakiApi');

async function getNetworkSummary(req, res) {
  const { networkId } = req.params;
  const startTime = Date.now();
  const { query = {} } = req;
  // Par├ímetros de control
  const forceLldpRefresh = (query.forceLldpRefresh || '').toString().toLowerCase() === 'true' || (query.forceLldpRefresh || '').toString() === '1';
  
  // Modo r├ípido: solo carga esencial (topology, devices, switches b├ísicos)
  const quickMode = query.quick === 'true' || query.quick === '1';

  const parseNumberParam = (value, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER, fallback = null } = {}) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    const clamped = Math.max(min, Math.min(max, parsed));
    return clamped;
  };

  const uplinkTimespan = parseNumberParam(query.uplinkTimespan ?? query.applianceTimespan, { min: 300, max: 7 * 24 * 3600, fallback: 24 * 3600 });
  const uplinkResolution = parseNumberParam(query.uplinkResolution, { min: 60, max: 3600, fallback: 300 });

  const normalizeStatus = (value, { defaultStatus = 'unknown', forPort = false } = {}) => {
    if (!value) return defaultStatus;
    const normalized = value.toString().trim().toLowerCase();
    
    // Estados de advertencia: dispositivo conectado pero con problemas
    const isWarning = /(alerting|warning|dormant|degraded)/.test(normalized);
    if (isWarning) return forPort ? 'Warning' : 'warning';
    
    // Estados offline/desconectado
    const isDown = /(not\s*connected|disconnected|down|offline|failed|inactive|unplugged)/.test(normalized);
    if (isDown) return forPort ? 'Disconnected' : 'offline';
    
    // Estados online/conectado
    const isUp = /(connected|online|up|active|ready|reachable|operational)/.test(normalized);
    if (isUp) return forPort ? 'Connected' : 'online';
    
    return defaultStatus;
  };

  const normalizeApplianceUplinks = (raw, context = {}) => {
    const uplinks = [];
    const pushEntry = (entry = {}, meta = {}) => {
      if (!entry) return;
      const statusLabel = entry.status || entry.reachability || meta.status || 'unknown';
      const statusNormalized = normalizeStatus(statusLabel, { defaultStatus: statusLabel });
      uplinks.push({
        serial: meta.serial || entry.serial || context.serial,
        interface: entry.interface || entry.name || meta.interface || 'WAN',
        status: statusLabel,
        statusNormalized,
        ip: entry.ip || entry.wanIp || entry.primaryIp,
        publicIp: entry.publicIp || entry.publicIP,
        subnet: entry.subnet,
        gateway: entry.gateway,
        latency: entry.latency ?? entry.latencyMs,
        loss: entry.loss ?? entry.lossPercent,
        jitter: entry.jitter ?? entry.jitterMs,
        connectionType: entry.connectionType,
        usingStaticIp: entry.usingStaticIp,
        provider: entry.provider,
        signalStat: entry.signalStat || entry.signalStatistics,
        signalType: entry.signalType,
        raw: entry
      });
    };

    const walk = (value, meta = {}) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach((item) => {
          if (item && Array.isArray(item.uplinks)) {
            walk(item.uplinks, { serial: item.serial || item.deviceSerial, interface: item.interface, ...meta });
          } else {
            pushEntry(item, meta);
          }
        });
        return;
      }

      if (value && typeof value === 'object') {
        if (Array.isArray(value.uplinks)) {
          walk(value.uplinks, { serial: value.serial || value.deviceSerial || meta.serial });
          return;
        }
        if (Array.isArray(value.items)) {
          walk(value.items, meta);
          return;
        }
        pushEntry(value, meta);
      }
    };

    walk(raw, context);
    return uplinks;
  };

  const normalizeSwitchPort = (serial, port) => {
    if (!port) return null;

    const serialCandidates = [
      serial,
      port.serial,
      port.switchSerial,
      port.deviceSerial,
      port.device?.serial,
      port.switch?.serial,
      port.deviceSerialNumber,
      port.switchSerialNumber
    ].filter(Boolean).map((value) => value.toString().trim());
    const serialAliases = Array.from(new Set(serialCandidates.filter(Boolean)));
    const resolvedSerial = serialAliases[0] || null;

    const macCandidates = [
      port.switchMac,
      port.mac,
      port.switch?.mac,
      port.deviceMac,
      port.device?.mac
    ].filter(Boolean).map((value) => value.toString().trim().toLowerCase());
    const macAliases = Array.from(new Set(macCandidates.filter(Boolean)));

    if (!resolvedSerial && macAliases.length === 0) return null;

    const status = normalizeStatus(port?.status || port?.linkStatus || port?.connectionStatus, { defaultStatus: port?.status || port?.linkStatus || 'unknown', forPort: true });
    return {
      serial: resolvedSerial,
      serialAliases,
      macAliases,
      switchId: port.switchId || port.deviceId || port.switch?.id || null,
      portId: port.portId ?? port.number ?? port.port ?? port.portNumber,
      name: port.name,
      enabled: port.enabled,
      status,
      statusNormalized: status ? status.toLowerCase() : 'unknown',
      statusRaw: port.status || port.linkStatus || port.connectionStatus,
      isUplink: port.isUplink ?? (port.type === 'uplink'),
      vlan: port.vlan,
      type: port.type,
      speed: port.speed ?? port.speedMbps ?? port.linkSpeed,
      duplex: port.duplex,
      poeEnabled: port.poeEnabled ?? port.poe ?? undefined,
      linkNegotiation: port.linkNegotiation
    };
  };

  const fillDeviceConnectionFromLldp = (device, payload) => {
    if (!device || !payload) return false;

    const portRecords = [];
    if (payload.ports && typeof payload.ports === 'object') {
      portRecords.push(...Object.values(payload.ports));
    }
    if (payload.interfaces && typeof payload.interfaces === 'object') {
      portRecords.push(...Object.values(payload.interfaces));
    }
    if (Array.isArray(payload.entries)) {
      portRecords.push(...payload.entries);
    }
    if (Array.isArray(payload.neighbors)) {
      portRecords.push(...payload.neighbors);
    }
    if (payload.lldp) {
      portRecords.push(payload.lldp);
    }

    const record = portRecords.find((entry) => entry && (entry.lldp || entry.cdp || entry.portId || entry.port || entry.portDescription));
    if (!record) return false;

    const lldpInfo = record.lldp || record;
    const cdpInfo = record.cdp;
    let updated = false;

    const buildLabel = (systemName, portId, portDescription) => {
      if (!systemName) return null;
      const portLabel = portId || portDescription;
      return portLabel ? `${systemName} / ${portLabel}` : systemName;
    };

    const lldpLabel = lldpInfo ? buildLabel(lldpInfo.systemName, lldpInfo.portId || lldpInfo.port, lldpInfo.portDescription) : null;
    const cdpLabel = cdpInfo ? buildLabel(cdpInfo.deviceId || cdpInfo.deviceIdV2, cdpInfo.portId || cdpInfo.port, cdpInfo.portDescription) : null;

    const resolvedPortId = lldpInfo?.portId || lldpInfo?.port || cdpInfo?.portId || cdpInfo?.port || record.portId || record.port || null;

    if (lldpLabel) {
      device.connectedTo = lldpLabel;
      updated = true;
    } else if (cdpLabel) {
      device.connectedTo = cdpLabel;
      updated = true;
    }

    if (resolvedPortId && !device.connectedPort) {
      device.connectedPort = resolvedPortId;
    }

    // Solo asignar wiredSpeed si podemos inferirlo de la descripción LLDP/CDP
    // No asignar valor por defecto - dejar null para mostrar '-' hasta obtener datos reales
    if (!device.wiredSpeed) {
      const descriptor = [cdpInfo?.platform, lldpInfo?.systemDescription, lldpInfo?.portDescription].filter(Boolean).join(' ');
      if (/10g|10000/i.test(descriptor)) {
        device.wiredSpeed = '10 Gbps';
      } else if (/2500|2\.5g/i.test(descriptor)) {
        device.wiredSpeed = '2.5 Gbps';
      }
      // NO inferir velocidades comunes por defecto - dejamos null para mostrar '-'
    }

    return updated;
  };

  const buildAccessPointsPayload = ({ accessPoints = [], wirelessInsights = null } = {}) => {
    if (!Array.isArray(accessPoints) || !accessPoints.length) return [];

    const serialVariantsOf = (serial) => {
      const normalized = (serial || '').toString().trim().toUpperCase();
      if (!normalized) return [];
      const variants = [normalized];
      const compact = normalized.replace(/-/g, '');
      if (compact && compact !== normalized) variants.push(compact);
      return variants;
    };

    const wirelessMap = new Map();
    if (Array.isArray(wirelessInsights?.devices)) {
      wirelessInsights.devices.forEach((device) => {
        serialVariantsOf(device?.serial).forEach((key) => {
          if (key && !wirelessMap.has(key)) {
            wirelessMap.set(key, device);
          }
        });
      });
    }

    const extractPortFromLabel = (label) => {
      if (!label) return null;
      const match = label.toString().match(/(?:port|puerto)\s*(\d+)/i);
      if (match) return match[1];
      const trailingNumber = label.toString().match(/(\d+)(?:\/?\d+)*$/);
      return trailingNumber ? trailingNumber[1] : null;
    };

    return accessPoints.map((ap) => {
      const serialKeys = serialVariantsOf(ap?.serial);
      const wirelessDetail = serialKeys.map((key) => wirelessMap.get(key)).find(Boolean) || null;
      const signalSummary = wirelessDetail?.signalSummary || null;
      const connectedTo = ap?.connectedTo || '-';
      const connectedPort = (ap?.connectedPort || extractPortFromLabel(connectedTo) || '-').toString();
      const wiredSpeed = ap?.wiredSpeed || null;

      const tooltipInfo = {
        type: 'access-point',
        name: ap?.name || ap?.serial,
        model: ap?.model,
        serial: ap?.serial,
        mac: ap?.mac,
        firmware: ap?.firmware,
        lanIp: ap?.lanIp,
        status: ap?.status,
        signalQuality: signalSummary?.latest ?? signalSummary?.average ?? null,
        clients: Array.isArray(wirelessDetail?.clients) ? wirelessDetail.clients.length : null,
        microDrops: signalSummary?.microDrops ?? wirelessDetail?.microDrops ?? 0,
        microDurationSeconds: signalSummary?.microDurationSeconds ?? wirelessDetail?.microDurationSeconds ?? 0,
        connectedTo,
        wiredPort: connectedPort,
        wiredSpeed,
        power: ap?.power ?? null,
      };

      const wirelessPayload = wirelessDetail ? {
        signalSummary,
        history: Array.isArray(wirelessDetail.history) ? wirelessDetail.history : [],
        microDrops: wirelessDetail.microDrops ?? signalSummary?.microDrops ?? 0,
        microDurationSeconds: wirelessDetail.microDurationSeconds ?? signalSummary?.microDurationSeconds ?? 0,
        deviceAggregate: wirelessDetail.deviceAggregate || null,
        failedConnections: wirelessDetail.failedConnections || null,
        failureHistory: wirelessDetail.failureHistory || null,
        clients: wirelessDetail.clients || null,
      } : {
        signalSummary: null,
        history: [],
        microDrops: 0,
        microDurationSeconds: 0,
        deviceAggregate: null,
        failedConnections: null,
        failureHistory: null,
        clients: null,
      };

      return {
        serial: ap?.serial,
        name: ap?.name,
        model: ap?.model,
        status: ap?.status,
        mac: ap?.mac,
        lanIp: ap?.lanIp,
        connectedTo,
        connectedPort,
        wiredSpeed,
        tooltipInfo,
        wireless: wirelessPayload,
        lastReportedAt: ap?.lastReportedAt || wirelessDetail?.lastReportedAt || null,
      };
    });
  };

  const resolveUplinkAddressKey = (value) => {
    if (!value) return null;
    const normalized = value.toString().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!normalized) return null;
    if (normalized.includes('wan1') || normalized === 'wan') return 'wan1';
    if (normalized.includes('wan2')) return 'wan2';
    if (normalized.includes('cell') || normalized.includes('lte') || normalized.includes('modem')) return 'cellular';
    if (normalized.includes('wan3')) return 'wan3';
    return normalized;
  };

  // Inferir velocidad Ethernet basada en el modelo del AP
  // Solo retorna valores cuando hay certeza del puerto físico, null si no se puede determinar
  const inferSpeedFromModel = (model) => {
    if (!model) return null;
    const normalized = model.toString().toUpperCase();
    // MR access points con puerto multigigabit conocido
    if (/MR(4[4-9]|5[0-9]|7[0-9]|8[0-9])/i.test(normalized)) return '2.5 Gbps';
    // NO inferir velocidades para otros modelos - dejar null para mostrar '-'
    // El dato real vendrá del LLDP/CDP
    return null;
  };

  const flattenAppliancePortStatuses = (raw) => {
    const list = [];
    const push = (entry = {}, meta = {}) => {
      if (!entry) return;
      const portId = entry.portId ?? entry.port ?? entry.portNumber ?? entry.number ?? meta.portId;
      if (portId === undefined || portId === null) return;
      const normalized = {
        portId: portId.toString(),
        name: entry.name || meta.name || null,
        enabled: entry.enabled ?? entry.isEnabled ?? meta.enabled,
        status: entry.status || entry.linkStatus || entry.connectionStatus || meta.status,
        speed: entry.speed ?? entry.speedMbps ?? entry.linkSpeed ?? entry.speedMb ?? null,
        duplex: entry.duplex || entry.linkDuplex || entry.duplexMode || null,
        negotiation: entry.linkNegotiation || entry.autoNegotiation || null,
        usage: entry.usage ?? entry.usageInKb ?? entry.usageKb ?? null,
        usageDown: entry.usageDown ?? entry.downstreamKbps ?? entry.receivingKbps ?? null,
        usageUp: entry.usageUp ?? entry.upstreamKbps ?? entry.sendingKbps ?? null,
        poeEnabled: entry.poeEnabled ?? entry.poe ?? meta.poeEnabled,
        poeUsage: entry.poeUsage ?? entry.poeUsageMw ?? entry.poeUsageW ?? null,
        vlan: entry.vlan ?? entry.accessVlan,
        allowedVlans: entry.allowedVlans,
        type: entry.type || entry.portType || entry.role,
        role: entry.role || entry.portRole,
        comment: entry.comment || entry.notes,
        mac: entry.mac || entry.portMac,
        ip: entry.ip || entry.portIp,
        raw: entry,
      };
      list.push(normalized);
    };

    const walk = (value, meta = {}) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach((item) => walk(item, meta));
        return;
      }
      if (typeof value === 'object') {
        if (Array.isArray(value.ports)) {
          walk(value.ports, { ...meta, name: value.name || meta.name, portId: value.portId || meta.portId });
          return;
        }
        if (Array.isArray(value.items)) {
          walk(value.items, meta);
          return;
        }
        push(value, meta);
      }
    };

    walk(raw);
    return list;
  };

  const deducePortRole = (source = {}) => {
    const candidates = [source.role, source.type, source.usage, source.name, source.comment, source.interface]
      .filter(Boolean)
      .map((val) => val.toString().toLowerCase());
    if (!candidates.length) return 'lan';
    if (candidates.some((val) => /wan|internet|uplink/.test(val))) return 'wan';
    if (candidates.some((val) => /management/.test(val))) return 'management';
    if (candidates.some((val) => /lan/.test(val))) return 'lan';
    if (candidates.some((val) => /wifi|wireless/.test(val))) return 'wifi';
    return 'lan';
  };

  const normalizeInterfaceKey = (value) => {
    if (value === undefined || value === null) return null;
    return value.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  };

  const mergeAppliancePorts = (configs = [], statuses = [], uplinks = []) => {
    const parseSpeedValue = (value) => {
      if (value === undefined || value === null || value === '') {
        return { speedMbps: null, speedLabel: null };
      }
      if (typeof value === 'number') {
        return { speedMbps: value, speedLabel: `${value} Mbps` };
      }
      const raw = value.toString().trim();
      if (!raw) return { speedMbps: null, speedLabel: null };
      const normalized = raw.toLowerCase();
      const numeric = parseFloat(normalized.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(numeric)) {
        return { speedMbps: null, speedLabel: raw };
      }
      let multiplier = 1;
      if (normalized.includes('gb')) multiplier = 1000;
      else if (normalized.includes('kb')) multiplier = 0.001;
      else if (normalized.includes('bps') && !normalized.includes('mbps')) multiplier = 0.000001;
      const speedMbps = Number((numeric * multiplier).toFixed(2));
      return { speedMbps, speedLabel: raw };
    };

    const configMap = new Map();
    configs.forEach((cfg) => {
      if (!cfg) return;
      const id = cfg.number ?? cfg.port ?? cfg.portId ?? cfg.name;
      if (id === undefined || id === null) return;
      const key = id.toString();
      configMap.set(key, {
        key,
        cfg,
        role: deducePortRole(cfg),
      });
    });

    const portMap = new Map();
    const upsertPort = (rawKey, updater) => {
      if (!rawKey && rawKey !== 0) return;
      const key = rawKey.toString();
      const previous = portMap.get(key) || {};
      const next = updater(previous) || previous;
      portMap.set(key, next);
    };

    const statusList = flattenAppliancePortStatuses(statuses);
    statusList.forEach((statusEntry) => {
      const rawKey = statusEntry.portId ?? statusEntry.port ?? statusEntry.number ?? statusEntry.name;
      if (rawKey === undefined || rawKey === null) return;
      const key = rawKey.toString();
      const configEntry = configMap.get(key);
      const role = statusEntry.role ? deducePortRole(statusEntry) : configEntry?.role || 'lan';
      const enabled = statusEntry.enabled ?? configEntry?.cfg?.enabled ?? true;
      const rawStatus = statusEntry.status || statusEntry.connectionStatus || configEntry?.cfg?.status || (enabled ? 'enabled' : 'disabled');
      const statusNormalized = normalizeStatus(rawStatus, { defaultStatus: enabled ? (rawStatus || 'unknown') : 'disabled', forPort: true });
      const { speedMbps, speedLabel } = parseSpeedValue(statusEntry.speed ?? statusEntry.speedMbps ?? configEntry?.cfg?.speed);
      const downKbps = statusEntry.usageDown ?? statusEntry.downstreamKbps ?? null;
      const upKbps = statusEntry.usageUp ?? statusEntry.upstreamKbps ?? null;
      const totalKbps = statusEntry.usage ?? statusEntry.totalKbps ?? (
        downKbps != null || upKbps != null ? (downKbps || 0) + (upKbps || 0) : null
      );

      upsertPort(key, (prev) => ({
        ...prev,
        portId: key,
        number: configEntry?.cfg?.number ?? prev.number ?? key,
        name: statusEntry.name || configEntry?.cfg?.name || prev.name || `Puerto ${key}`,
        role,
        isWan: role === 'wan',
        isManagement: role === 'management',
        type: statusEntry.type || configEntry?.cfg?.type || prev.type || null,
        enabled,
        status: rawStatus || prev.status,
        statusNormalized: statusNormalized || prev.statusNormalized,
        speedMbps: speedMbps ?? prev.speedMbps ?? null,
        speedLabel: speedLabel || prev.speedLabel || null,
        duplex: statusEntry.duplex ?? configEntry?.cfg?.duplex ?? prev.duplex ?? null,
        negotiation: statusEntry.negotiation ?? statusEntry.linkNegotiation ?? configEntry?.cfg?.linkNegotiation ?? prev.negotiation ?? null,
        vlan: statusEntry.vlan ?? configEntry?.cfg?.vlan ?? prev.vlan ?? null,
        allowedVlans: configEntry?.cfg?.allowedVlans ?? prev.allowedVlans ?? null,
        ip: statusEntry.ip ?? configEntry?.cfg?.ip ?? prev.ip ?? null,
        mac: statusEntry.mac ?? configEntry?.cfg?.mac ?? prev.mac ?? null,
        poeEnabled: statusEntry.poeEnabled ?? configEntry?.cfg?.poeEnabled ?? prev.poeEnabled ?? null,
        poeUsageMw: statusEntry.poeUsage ?? prev.poeUsageMw ?? null,
        usageKbps: totalKbps ?? prev.usageKbps ?? null,
        usageSplitKbps: {
          down: downKbps ?? prev.usageSplitKbps?.down ?? null,
          up: upKbps ?? prev.usageSplitKbps?.up ?? null,
        },
        comment: statusEntry.comment ?? configEntry?.cfg?.comment ?? configEntry?.cfg?.notes ?? prev.comment ?? null,
        raw: {
          status: statusEntry,
          config: configEntry?.cfg || prev.raw?.config || null,
        },
      }));

      configMap.delete(key);
    });

    configMap.forEach(({ key, cfg, role }) => {
      upsertPort(key, (prev) => {
        const enabled = cfg?.enabled ?? true;
        const rawStatus = cfg?.status || (enabled ? prev.status || null : 'disabled');
        const statusNormalized = normalizeStatus(rawStatus, { defaultStatus: enabled ? (rawStatus || 'unknown') : 'disabled', forPort: true });
        const { speedMbps, speedLabel } = parseSpeedValue(cfg?.speed);

        return {
          portId: prev.portId || key,
          number: prev.number ?? cfg?.number ?? key,
          name: prev.name || cfg?.name || `Puerto ${key}`,
          role: prev.role || role || deducePortRole(cfg),
          isWan: prev.isWan ?? role === 'wan',
          isManagement: prev.isManagement ?? role === 'management',
          type: prev.type || cfg?.type || null,
          enabled,
          status: rawStatus || prev.status || null,
          statusNormalized: prev.statusNormalized || statusNormalized,
          speedMbps: prev.speedMbps ?? speedMbps ?? null,
          speedLabel: prev.speedLabel || speedLabel || null,
          duplex: prev.duplex ?? cfg?.duplex ?? null,
          negotiation: prev.negotiation ?? cfg?.linkNegotiation ?? null,
          vlan: prev.vlan ?? cfg?.vlan ?? null,
          allowedVlans: prev.allowedVlans ?? cfg?.allowedVlans ?? null,
          ip: prev.ip ?? cfg?.ip ?? null,
          mac: prev.mac ?? cfg?.mac ?? null,
          poeEnabled: prev.poeEnabled ?? cfg?.poeEnabled ?? null,
          poeUsageMw: prev.poeUsageMw ?? null,
          usageKbps: prev.usageKbps ?? null,
          usageSplitKbps: prev.usageSplitKbps ?? { down: null, up: null },
          comment: prev.comment || cfg?.comment || cfg?.notes || null,
          raw: {
            status: prev.raw?.status || null,
            config: cfg,
          },
        };
      });
    });

    const uplinkMap = new Map();
    uplinks.forEach((uplink) => {
      const key = normalizeInterfaceKey(uplink?.interface || uplink?.name || uplink?.wan);
      if (!key) return;
      uplinkMap.set(key, uplink);
    });

    const toInterfaceKey = (value) => normalizeInterfaceKey(value) || null;

    const derivePortInterfaceKey = (port) => {
      const candidates = [
        port.uplink?.interface,
        port.raw?.status?.interface,
        port.raw?.status?.wan,
        port.raw?.status?.name,
        port.name,
        port.portId,
        port.type,
        port.role,
      ];
      for (const candidate of candidates) {
        const keyCandidate = toInterfaceKey(candidate);
        if (keyCandidate) return keyCandidate;
      }
      return null;
    };

    const seenInterfaceKeys = new Set();
    let mergedPorts = Array.from(portMap.entries()).map(([key, port]) => {
      const candidates = [
        key,
        port.name,
        port.role,
        port.type,
        port.raw?.config?.name,
        port.raw?.config?.portId,
        port.raw?.status?.interface,
        port.raw?.status?.wan,
      ]
        .filter(Boolean)
        .map((value) => normalizeInterfaceKey(value));

      let matchedUplink = null;
      for (const candidate of candidates) {
        if (!candidate) continue;
        if (uplinkMap.has(candidate)) {
          matchedUplink = uplinkMap.get(candidate);
          seenInterfaceKeys.add(candidate);
          break;
        }
      }

      if (!matchedUplink && port.role === 'wan') {
        if (uplinkMap.has('wan')) {
          matchedUplink = uplinkMap.get('wan');
          seenInterfaceKeys.add('wan');
        } else if (/\d/.test(key)) {
          const normalized = key.replace(/[^0-9]/g, '');
          if (normalized.endsWith('1') && uplinkMap.has('wan1')) {
            matchedUplink = uplinkMap.get('wan1');
            seenInterfaceKeys.add('wan1');
          }
          if (normalized.endsWith('2') && uplinkMap.has('wan2')) {
            matchedUplink = uplinkMap.get('wan2');
            seenInterfaceKeys.add('wan2');
          }
        }
      }

      if (matchedUplink) {
        const uplinkStatus = matchedUplink.statusNormalized || matchedUplink.status || port.status;
        const normalizedStatus = normalizeStatus(uplinkStatus, { defaultStatus: uplinkStatus || port.status || 'unknown', forPort: true });
        port = {
          ...port,
          status: uplinkStatus || port.status,
          statusNormalized: normalizedStatus || port.statusNormalized,
          enabled: port.enabled ?? normalizedStatus !== 'Disconnected',
          isWan: true,
          role: 'wan',
          uplink: {
            interface: matchedUplink.interface || matchedUplink.name || matchedUplink.wan || null,
            ip: matchedUplink.ip || null,
            publicIp: matchedUplink.publicIp || matchedUplink.publicIP || null,
            provider: matchedUplink.provider || matchedUplink.addressDetails?.provider || matchedUplink.addressDetails?.isp || null,
            loss: matchedUplink.loss ?? matchedUplink.lossPercent ?? null,
            latency: matchedUplink.latency ?? matchedUplink.latencyMs ?? null,
            jitter: matchedUplink.jitter ?? matchedUplink.jitterMs ?? null,
          },
        };
      }

      if (!port.statusNormalized) {
        port.statusNormalized = normalizeStatus(port.status, { defaultStatus: port.enabled === false ? 'disabled' : 'unknown', forPort: true });
      }

      if (!port.speedLabel && port.speedMbps != null) {
        port.speedLabel = `${port.speedMbps} Mbps`;
      }

      const interfaceKey = derivePortInterfaceKey(port) || normalizeInterfaceKey(key);
      if (interfaceKey) {
        seenInterfaceKeys.add(interfaceKey);
      }

      return port;
    });

    const wanLabelFor = (iface) => {
      const normalized = normalizeInterfaceKey(iface);
      if (normalized && /^wan(\d+)$/.test(normalized)) {
        const match = normalized.match(/^wan(\d+)$/);
        const idx = match && match[1] ? match[1] : '';
        return { display: `WAN ${idx || '1'}`, id: `WAN ${idx || '1'}` };
      }
      if (normalized === 'wan') {
        return { display: 'WAN', id: 'WAN' };
      }
      if (normalized === 'cellular' || normalized === 'lte') {
        return { display: 'Cellular', id: 'Cellular' };
      }
      const label = (iface || 'WAN').toString().trim() || 'WAN';
      return { display: label, id: label };
    };

    const usedPortIds = new Set(mergedPorts.map((port) => port.portId?.toString()));
    uplinks.forEach((uplink, index) => {
      if (!uplink) return;
      const interfaceRaw = uplink.interface || uplink.name || uplink.wan || null;
      const interfaceKey = toInterfaceKey(interfaceRaw);
      const statusLabel = uplink.status || uplink.reachability || uplink.statusNormalized || 'unknown';
      const normalizedStatus = normalizeStatus(statusLabel, { defaultStatus: statusLabel || 'unknown', forPort: true });

      if (interfaceKey && seenInterfaceKeys.has(interfaceKey)) {
        return;
      }

      if (interfaceKey) {
        seenInterfaceKeys.add(interfaceKey);
      }

      const labelInfo = wanLabelFor(interfaceRaw || `WAN ${index + 1}`);
      const down = uplink.rxKbps ?? uplink.downstreamKbps ?? uplink.receive ?? uplink.usageInKbps ?? uplink.downloadKbps ?? null;
      const up = uplink.txKbps ?? uplink.upstreamKbps ?? uplink.send ?? uplink.uploadKbps ?? null;
      const total = (down != null || up != null) ? (down || 0) + (up || 0) : null;

      let portId = interfaceRaw || labelInfo.id.replace(/\s+/g, '').toLowerCase() || `wan${index + 1}`;
      if (usedPortIds.has(portId)) {
        let suffix = 2;
        while (usedPortIds.has(`${portId}-${suffix}`)) {
          suffix += 1;
        }
        portId = `${portId}-${suffix}`;
      }
      usedPortIds.add(portId);

      mergedPorts.push({
        portId: portId.toString(),
        number: labelInfo.display,
        name: labelInfo.display,
        role: 'wan',
        isWan: true,
        isManagement: false,
        type: 'wan',
        enabled: normalizedStatus !== 'Disconnected',
        status: statusLabel,
        statusNormalized: normalizedStatus,
        speedMbps: null,
        speedLabel: null,
        duplex: null,
        negotiation: null,
        vlan: null,
        allowedVlans: null,
        ip: uplink.ip || null,
        mac: uplink.mac || null,
        poeEnabled: false,
        poeUsageMw: null,
        usageKbps: total,
        usageSplitKbps: {
          down: down ?? null,
          up: up ?? null,
        },
        comment: uplink.comment || null,
        uplink: {
          interface: interfaceRaw || labelInfo.id,
          ip: uplink.ip || null,
          publicIp: uplink.publicIp || uplink.publicIP || null,
          provider: uplink.provider || uplink.addressDetails?.provider || uplink.addressDetails?.isp || null,
          loss: uplink.loss ?? uplink.lossPercent ?? null,
          latency: uplink.latency ?? uplink.latencyMs ?? null,
          jitter: uplink.jitter ?? uplink.jitterMs ?? null,
        },
        raw: {
          status: uplink,
          config: null,
        },
      });
    });

    const roleRank = (role) => {
      if (!role) return 99;
      const normalized = role.toString().toLowerCase();
      if (normalized === 'wan') return 0;
      if (normalized === 'management') return 1;
      if (normalized === 'lan') return 2;
      return 3;
    };

    mergedPorts.sort((a, b) => {
      const rankDiff = roleRank(a.role) - roleRank(b.role);
      if (rankDiff !== 0) return rankDiff;
      const aNum = Number(a.number);
      const bNum = Number(b.number);
      if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
      return String(a.number ?? a.portId).localeCompare(String(b.number ?? b.portId), undefined, { numeric: true, sensitivity: 'base' });
    });

    return mergedPorts;
  };

  const summarizeAppliancePorts = (ports = []) => {
    return ports.reduce((acc, port) => {
      acc.total += 1;
      if (port.role === 'wan') acc.wan += 1;
      else if (port.role === 'management') acc.management += 1;
      else acc.lan += 1;

      if (port.enabled) acc.enabled += 1;
      else acc.disabled += 1;

      const normalized = (port.statusNormalized || '').toString().toLowerCase();
      if (normalized === 'connected') acc.connected += 1;
      else if (normalized === 'disconnected' || normalized === 'disabled') acc.disconnected += 1;
      else acc.unknown += 1;

      if (port.poeEnabled) {
        acc.poePorts += 1;
        if (normalized === 'connected') acc.poeActive += 1;
      }

      const kbps = port.usageKbps ?? null;
      if (kbps !== null) {
        acc.totalUsageKbps += kbps;
      }

      return acc;
    }, {
      total: 0,
      wan: 0,
      lan: 0,
      management: 0,
      enabled: 0,
      disabled: 0,
      connected: 0,
      disconnected: 0,
      unknown: 0,
      poePorts: 0,
      poeActive: 0,
      totalUsageKbps: 0,
    });
  };

  const enrichApplianceUplinksWithPortMapping = (uplinks = [], { switchPorts = [], applianceSerial = null, applianceModel = null } = {}) => {
    if (!Array.isArray(uplinks) || !uplinks.length) return uplinks;
    if (!Array.isArray(switchPorts) || !switchPorts.length) return uplinks;

    // Mapeo de modelo ÔåÆ layout de puertos f├¡sicos
    const MODEL_PORT_LAYOUTS = {
      'MX84': {
        wan1: 1,    // Puerto f├¡sico 1 = WAN1
        wan2: 2,    // Puerto f├¡sico 2 = WAN2
        // Puertos LAN: 3-10 (pares impares/pares)
        // Puertos SFP: 11-12
      },
      'MX64': {
        wan1: 1,
        wan2: 2,
      },
      'MX65': {
        wan1: 1,
        wan2: 2,
      },
      'MX67': {
        wan1: 1,
        wan2: 2,
      },
      'MX68': {
        wan1: 1,
        wan2: 2,
      },
      'MX75': {
        wan1: 1,
        wan2: 2,
      },
      'MX85': {
        wan1: 1,
        wan2: 2,
      },
      'MX95': {
        wan1: 1,
        wan2: 2,
      },
      'MX100': {
        wan1: 1,
        wan2: 2,
      },
      'MX250': {
        wan1: 1,
        wan2: 2,
      },
      'MX450': {
        wan1: 1,
        wan2: 2,
      },
    };

    // Encontrar puertos de switch marcados como uplink
    const uplinkSwitchPorts = switchPorts
      .filter((port) => port && (port.isUplink === true || (port.type || '').toLowerCase().includes('uplink')))
      .filter((port) => {
        const status = (port.statusNormalized || port.status || '').toString().toLowerCase();
        return status === 'connected' || status === 'online' || status.includes('active');
      });

    if (!uplinkSwitchPorts.length) {
      return uplinks;
    }

    // Obtener el layout de puertos para el modelo del appliance
    const normalizedModel = (applianceModel || '').toString().trim().toUpperCase();
    const portLayout = MODEL_PORT_LAYOUTS[normalizedModel];

    if (!portLayout) {
      return uplinks;
    }

    // Enriquecer uplinks con portNumber
    const enrichedUplinks = uplinks.map((uplink) => {
      if (!uplink) return uplink;

      const interfaceKey = (uplink.interface || '').toString().toLowerCase();
      const portNumber = portLayout[interfaceKey];

      if (portNumber !== undefined) {
  logger.debug(`Mapeando ${interfaceKey} al puerto f├¡sico ${portNumber} para ${applianceSerial}`);
        return {
          ...uplink,
          portNumber,
          _mappingSource: 'model-layout',
        };
      }

      return uplink;
    });

    // Logging para debug
    const mappedCount = enrichedUplinks.filter((u) => u.portNumber !== undefined).length;
  logger.debug(`${mappedCount}/${uplinks.length} uplinks mapeados para ${applianceSerial} (${normalizedModel})`);

    return enrichedUplinks;
  };

  // Funci├│n para enriquecer puertos del appliance con conectividad al switch/AP basada en topolog├¡a
  const enrichAppliancePortsWithSwitchConnectivity = (ports = [], { applianceSerial = null, applianceModel = null, topology = {}, switchesDetailed = [], accessPoints = [] } = {}) => {
    if (!Array.isArray(ports) || !ports.length) return ports;
    
    const serialUpper = (applianceSerial || '').toString().toUpperCase();
    if (!serialUpper) return ports;

  logger.debug(`Procesando puertos del appliance ${applianceSerial}`);

    // Map para almacenar conectividad detectada: portNumber -> { switchSerial, switchPort, switchName }
    const portConnectivity = new Map();

    // PASO 1: Usar datos reales de uplinkPortOnRemote de los switches
    logger.debug(`switchesDetailed recibidos: ${switchesDetailed.length} elementos`);
    
    switchesDetailed.forEach((switchInfo) => {
      if (!switchInfo.uplinkPortOnRemote) return;
      
      const switchName = switchInfo.name || switchInfo.serial;
      const appliancePort = switchInfo.uplinkPortOnRemote;
      
      // Buscar puerto uplink activo del switch
      const uplinkPorts = switchInfo.stats?.uplinkPorts || [];
      const activeUplinkPort = uplinkPorts.find((port) => {
        const portStatus = (port.statusNormalized || port.status || '').toLowerCase();
        return portStatus === 'connected' || portStatus === 'online' || portStatus.includes('active');
      });

      if (activeUplinkPort) {
        const switchPortNumber = activeUplinkPort.portId || activeUplinkPort.number;
        
        portConnectivity.set(appliancePort.toString(), {
          deviceSerial: switchInfo.serial,
          devicePort: switchPortNumber,
          deviceName: switchName,
          deviceType: 'switch',
          _sourceMethod: 'lldp-real-data',
        });
        
  logger.debug(`Puerto ${appliancePort} del appliance al switch ${switchName}, puerto ${switchPortNumber} (LLDP)`);
      }
    });

    // PASO 2: Detectar APs conectados directamente al appliance (redes GAP con Z3)
    // Los APs ya tienen procesado su LLDP en la secci├│n access_points
    const isZ3 = applianceModel && applianceModel.toString().trim().toUpperCase().startsWith('Z3');
    if (isZ3 && Array.isArray(accessPoints) && accessPoints.length > 0) {
      logger.debug(`Detectando APs conectados al Z3, total APs: ${accessPoints.length}`);
      
      // REGLA: En redes GAP (Z3 + APs sin switch), el AP SIEMPRE va en puerto 5 (PoE)
      // Si hay exactamente 1 AP y no hay switches, es GAP
      const isGAP = accessPoints.length === 1 && switchesDetailed.length === 0;
      
      // Buscar APs que est├®n conectados directamente a este appliance
      accessPoints.forEach((ap) => {
        // El AP ya tiene procesado su connectedTo y connectedPort desde networksController
        const connectedTo = ap.connectedTo || '';
        let connectedPort = ap.connectedPort || '';
        
        logger.debug(`AP ${ap.serial} (${ap.name}): connectedTo="${connectedTo}", connectedPort="${connectedPort}"`);
        
        // Si connectedPort est├í vac├¡o, intentar extraer desde connectedTo
        // Formato: "615285 - appliance / 3" o "Z3/Port 5"
        if (!connectedPort || connectedPort === '-') {
          const portMatch = connectedTo.match(/\/\s*(?:Port\s*)?(\d+)$/i);
          if (portMatch) {
            connectedPort = portMatch[1];
            logger.debug(`  Puerto extra├¡do de connectedTo: ${connectedPort}`);
          }
        }
        
        // Verificar si est├í conectado a un appliance (no a un switch)
        // connectedTo viene como "Z3/Port 5" o "615263/Port 5" (nombre del predio)
        // Si NO contiene "SW" o "MS" (switch), entonces est├í conectado directo al Z3
        const isConnectedToSwitch = /\b(SW|MS|Switch)\b/i.test(connectedTo);
        
        logger.debug(`  isConnectedToSwitch: ${isConnectedToSwitch}, isGAP: ${isGAP}`);
        
        if (!isConnectedToSwitch && connectedPort && connectedPort !== '-') {
          // Extraer n├║mero de puerto
          let apPortOnZ3 = connectedPort.match(/(\d+)(?:\/\d+)*$/) ? 
                           connectedPort.match(/(\d+)(?:\/\d+)*$/)[1] : 
                           connectedPort;
          
          // CORRECCI├ôN: En GAP, el AP SIEMPRE est├í en puerto 5 (PoE)
          // El LLDP a veces reporta puerto incorrecto
          if (isGAP) {
            logger.debug(`  Configuraci├│n GAP detectada - forzando puerto 5 (era ${apPortOnZ3})`);
            apPortOnZ3 = '5';
          }
          
          logger.debug(`  Puerto final: ${apPortOnZ3}`);
          
          if (apPortOnZ3) {
            const apName = ap.name || ap.model || ap.serial;
            
            portConnectivity.set(apPortOnZ3.toString(), {
              deviceSerial: ap.serial,
              devicePort: '-',
              deviceName: apName,
              deviceType: 'ap',
              _sourceMethod: isGAP ? 'gap-rule-port5' : 'lldp-ap-processed',
            });
            
            logger.debug(`✓ Puerto ${apPortOnZ3} del Z3 al AP ${apName}`);
          }
        }
      });
    }

    // PASO 3: Inferencia por modelo cuando no hay LLDP directo (fallback)
    // Si hay switches pero no detectamos puerto de conexión, inferir por modelo
    if (!portConnectivity.size && switchesDetailed.length > 0 && applianceModel) {
      const modelUpper = applianceModel.toString().toUpperCase().trim();
      
      // Mapeo modelo → puerto típico de uplink LAN
      let inferredPort = null;
      if (modelUpper.startsWith('MX84') || modelUpper.startsWith('MX100')) {
        inferredPort = '10'; // MX84/100: último puerto LAN es típicamente el uplink
      } else if (modelUpper.startsWith('MX64') || modelUpper.startsWith('MX65') || modelUpper.startsWith('MX67') || modelUpper.startsWith('MX68')) {
        inferredPort = '3'; // MX64/65/67/68: tienen menos puertos, puerto 3 es común
      } else if (modelUpper.startsWith('MX250') || modelUpper.startsWith('MX450')) {
        inferredPort = '11'; // Modelos enterprise con más puertos
      } else if (modelUpper.startsWith('Z3') || modelUpper.startsWith('Z4')) {
        inferredPort = '5'; // Z-series: puerto 5 es el PoE/LAN principal
      }
      
      if (inferredPort) {
        const firstSwitch = switchesDetailed[0];
        const switchName = firstSwitch.name || firstSwitch.serial;
        
        portConnectivity.set(inferredPort, {
          deviceSerial: firstSwitch.serial,
          devicePort: '-',
          deviceName: switchName,
          deviceType: 'switch',
          _sourceMethod: 'model-inference',
        });
        
        logger.info(`✓ Puerto ${inferredPort} inferido por modelo ${applianceModel} al switch ${switchName}`);
      }
    }

    if (!portConnectivity.size) {
      logger.info(`No se detectaron conexiones de switches/APs al appliance`);
      return ports;
    }

    // Enriquecer puertos con informaci├│n de conectividad
    const enrichedPorts = ports.map((port) => {
      if (!port) return port;

      const portKey = (port.number || port.portId || port.name || '').toString();
      const connectivity = portConnectivity.get(portKey);

      if (connectivity) {
        const deviceLabel = connectivity.deviceType === 'ap' ? 'AP' : 'Switch';
        const portInfo = connectivity.deviceType === 'ap' ? '' : ` / Puerto ${connectivity.devicePort}`;
        
        // Marcar puerto como conectado con status real + metadata para tooltip
        return {
          ...port,
          connectedTo: `${connectivity.deviceName}${portInfo}`,
          connectedDevice: connectivity.deviceSerial,
          connectedDevicePort: connectivity.devicePort,
          connectedDeviceType: connectivity.deviceType,
          // Force connected status for UI display (green indicator)
          statusNormalized: 'connected',
          status: 'active',
          hasCarrier: true, // ← Critical para que el puerto se muestre verde
          _connectivitySource: connectivity._sourceMethod,
          // Tooltip metadata
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

    const enrichedCount = enrichedPorts.filter((p) => p.connectedTo).length;
  logger.debug(`${enrichedCount}/${ports.length} puertos enriquecidos con conectividad`);

    return enrichedPorts;
  };

  /**
   * Limpia enlaces duplicados del appliance en la topolog├¡a.
   * Los appliances MX suelen tener m├║ltiples enlaces reportados (WAN, Internet, LAN),
   * pero en la topolog├¡a visual solo debe aparecer el enlace LAN principal hacia el switch.
   * 
   * @param {Object} topology - Objeto con {nodes, links}
   * @param {Array} appliances - Lista de appliances [mxDevice, ...utms]
   * @returns {Object} Topolog├¡a con enlaces del appliance filtrados
   */
  const cleanDuplicateApplianceLinks = (topology, appliances) => {
    if (!topology || !Array.isArray(topology.links) || !appliances?.length) {
      return topology;
    }

    const applianceSerials = new Set(appliances.map(a => a?.serial).filter(Boolean));
    if (!applianceSerials.size) return topology;

    // Separar enlaces: los que involucran appliances vs otros
    const applianceLinks = [];
    const otherLinks = [];

    topology.links.forEach(link => {
      const sourceIsAppliance = applianceSerials.has(link.source);
      const targetIsAppliance = applianceSerials.has(link.target);
      
      if (sourceIsAppliance || targetIsAppliance) {
        applianceLinks.push(link);
      } else {
        otherLinks.push(link);
      }
    });

    // Para cada appliance, mantener solo 1 enlace hacia switches
    const keepLinks = [];
    applianceSerials.forEach(applianceSerial => {
      const linksFromAppliance = applianceLinks.filter(link => 
        link.source === applianceSerial || link.target === applianceSerial
      );

      if (!linksFromAppliance.length) return;

      // Identificar enlaces a switches (seriales que empiezan con Q2)
      const switchLinks = linksFromAppliance.filter(link => {
        const otherSerial = link.source === applianceSerial ? link.target : link.source;
        return otherSerial?.startsWith('Q2');
      });

      if (switchLinks.length) {
        // Mantener solo el primer enlace a switch (normalmente el principal)
        keepLinks.push(switchLinks[0]);
        logger.debug(`Appliance ${applianceSerial}: manteniendo enlace a ${switchLinks[0].target === applianceSerial ? switchLinks[0].source : switchLinks[0].target}, eliminando ${linksFromAppliance.length - 1} duplicados`);
      } else {
        // Si no hay enlaces a switches, mantener el primero que haya
        keepLinks.push(linksFromAppliance[0]);
        logger.debug(`Appliance ${applianceSerial}: sin enlaces a switches, manteniendo primer enlace disponible`);
      }
    });

    return {
      ...topology,
      links: [...otherLinks, ...keepLinks]
    };
  };

  const normalizeUplinkHistory = (lossLatencyRaw, usageRaw, { serialHint } = {}) => {
    const seriesMap = new Map();

    const ensureSeries = (serial, interfaceName) => {
      const key = `${(serial || serialHint || 'unknown').toString().toUpperCase()}::${(interfaceName || 'WAN').toString().toUpperCase()}`;
      if (!seriesMap.has(key)) {
        seriesMap.set(key, {
          key,
          serial: serial || serialHint || null,
          interface: interfaceName || 'WAN',
          points: [],
          _pointIndex: new Map(),
        });
      }
      return seriesMap.get(key);
    };

    const ensurePoint = (series, timestamp) => {
      if (!timestamp) return null;
      const key = timestamp;
      if (!series._pointIndex.has(key)) {
        const point = { timestamp };
        series._pointIndex.set(key, point);
        series.points.push(point);
      }
      return series._pointIndex.get(key);
    };

    const ingestLossLatency = (value, meta = {}) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach((item) => ingestLossLatency(item, meta));
        return;
      }
      if (typeof value === 'object') {
        if (Array.isArray(value.timeSeries)) {
          value.timeSeries.forEach((item) => ingestLossLatency(item, { serial: value.serial || meta.serial, interface: value.interface || meta.interface }));
          return;
        }
        if (Array.isArray(value.items)) {
          value.items.forEach((item) => ingestLossLatency(item, meta));
          return;
        }
        if (Array.isArray(value.uplinks)) {
          value.uplinks.forEach((item) => ingestLossLatency(item, { serial: value.serial || value.deviceSerial || meta.serial }));
          return;
        }

        const serial = value.serial || value.deviceSerial || meta.serial || serialHint;
  const interfaceName = value.interface ?? value.wan ?? meta.interface;
        const timestamp = value.startTs || value.ts || value.timestamp || value.time || value.sample || null;
        if (!timestamp) return;
        const series = ensureSeries(serial, interfaceName);
        const point = ensurePoint(series, timestamp);
        if (!point) return;
        const statusLabel = value.status || value.reachability || meta.status || null;
        point.status = statusLabel;
        point.statusNormalized = normalizeStatus(statusLabel, { defaultStatus: statusLabel || 'unknown', forPort: true });
        point.latencyMs = value.latencyMs ?? value.latency ?? null;
        point.lossPercent = value.lossPercent ?? value.loss ?? null;
        point.jitterMs = value.jitterMs ?? value.jitter ?? null;
      }
    };

    const ingestUsage = (value, meta = {}) => {
      if (!value) return;
      if (Array.isArray(value)) {
        value.forEach((item) => ingestUsage(item, meta));
        return;
      }
      if (typeof value === 'object') {
        if (Array.isArray(value.timeSeries)) {
          value.timeSeries.forEach((item) => ingestUsage(item, { serial: value.serial || meta.serial, interface: value.interface || meta.interface }));
          return;
        }
        if (Array.isArray(value.items)) {
          value.items.forEach((item) => ingestUsage(item, meta));
          return;
        }
        if (Array.isArray(value.uplinks)) {
          value.uplinks.forEach((item) => ingestUsage(item, { serial: value.serial || value.deviceSerial || meta.serial }));
          return;
        }

        const serial = value.serial || value.deviceSerial || meta.serial || serialHint;
  const interfaceName = value.interface ?? value.wan ?? meta.interface;
        const timestamp = value.startTs || value.ts || value.timestamp || value.time || value.sample || null;
        if (!timestamp) return;
        const series = ensureSeries(serial, interfaceName);
        const point = ensurePoint(series, timestamp);
        if (!point) return;
        const down = value.rxKbps ?? value.receive ?? value.receivingKbps ?? value.downstreamKbps ?? value.usageInKbps ?? value.downloadKbps ?? null;
        const up = value.txKbps ?? value.send ?? value.sendingKbps ?? value.upstreamKbps ?? value.uploadKbps ?? null;
        if (down != null) point.rxKbps = down;
        if (up != null) point.txKbps = up;
        if (down != null || up != null) {
          point.totalKbps = (down || 0) + (up || 0);
        }
      }
    };

    ingestLossLatency(lossLatencyRaw);
    ingestUsage(usageRaw);

    const result = Array.from(seriesMap.values()).map((series) => {
      series.points.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      let offlineCount = 0;
      let offlineDurationSeconds = 0;
      let currentDownStart = null;
      let lastTimestamp = null;
      const events = [];

      series.points.forEach((point) => {
        const ts = new Date(point.timestamp).getTime();
        if (!Number.isFinite(ts)) return;
        if (point.statusNormalized && point.statusNormalized.toLowerCase() === 'disconnected') {
          if (currentDownStart === null) currentDownStart = ts;
        } else {
          if (currentDownStart !== null) {
            offlineCount += 1;
            const duration = Math.max(0, ts - currentDownStart);
            offlineDurationSeconds += duration / 1000;
            events.push({ start: new Date(currentDownStart).toISOString(), end: new Date(ts).toISOString(), durationSeconds: duration / 1000 });
            currentDownStart = null;
          }
        }
        lastTimestamp = ts;
      });

      if (currentDownStart !== null && lastTimestamp !== null) {
        const duration = Math.max(0, lastTimestamp - currentDownStart);
        offlineDurationSeconds += duration / 1000;
        offlineCount += 1;
        events.push({ start: new Date(currentDownStart).toISOString(), end: new Date(lastTimestamp).toISOString(), durationSeconds: duration / 1000 });
      }

      return {
        serial: series.serial,
        interface: series.interface,
        points: series.points,
        health: {
          offlineCount,
          offlineDurationSeconds,
          events,
        },
      };
    });

    return result;
  };

  const ensureUplinkHistoryCoverage = (history = [], uplinks = [], { timespanSeconds = 3600, now = Date.now(), serialHint = null } = {}) => {
    const toInterfaceKey = (value) => {
      const normalized = normalizeInterfaceKey(value);
      if (normalized) return normalized;
      if (value === undefined || value === null) return null;
      return value.toString().trim().toLowerCase();
    };

    const cloneHealth = (health) => ({
      offlineCount: health?.offlineCount ?? 0,
      offlineDurationSeconds: health?.offlineDurationSeconds ?? 0,
      events: Array.isArray(health?.events) ? [...health.events] : [],
    });

    const safeNowMs = typeof now === 'number' ? now : new Date(now).getTime();
    const timespanSec = Number.isFinite(timespanSeconds) && timespanSeconds > 0 ? timespanSeconds : 3600;
    const startMs = safeNowMs - timespanSec * 1000;
    const startIso = new Date(startMs).toISOString();
    const nowIso = new Date(safeNowMs).toISOString();

    const normalizePoint = (point = {}) => {
      if (!point) return null;
      const normalized = { ...point };
      const ts = point.timestamp || point.ts || point.time || point.sample || point.startTs || point.endTs;
      if (ts) {
        const epoch = new Date(ts).getTime();
        if (Number.isFinite(epoch)) {
          normalized.timestamp = new Date(epoch).toISOString();
        }
      }
      if (!normalized.timestamp) return null;
      const statusLabel = normalized.status || normalized.statusNormalized;
      if (statusLabel && !normalized.statusNormalized) {
        normalized.statusNormalized = normalizeStatus(statusLabel, { defaultStatus: statusLabel, forPort: true });
      }
      return normalized;
    };

    const seriesMap = new Map();

    const upsertSeries = (key, meta = {}) => {
      const resolvedKey = key || `iface-${seriesMap.size}`;
      if (!seriesMap.has(resolvedKey)) {
        seriesMap.set(resolvedKey, {
          serial: meta.serial || serialHint || null,
          interface: meta.interface || meta.interfaceLabel || 'WAN',
          points: [],
          health: cloneHealth(meta.health),
          _statusHint: meta.statusHint || null,
        });
      }
      const series = seriesMap.get(resolvedKey);
      if (!series.health) series.health = cloneHealth(meta.health);
      if (!series.serial && meta.serial) series.serial = meta.serial;
      if (!series.interface && meta.interface) series.interface = meta.interface;
      if (meta.statusHint) series._statusHint = meta.statusHint;
      return series;
    };

    (Array.isArray(history) ? history : []).forEach((entry) => {
      if (!entry) return;
      const key = toInterfaceKey(entry.interface);
      const series = upsertSeries(key, { interface: entry.interface, serial: entry.serial, health: entry.health });
      const points = Array.isArray(entry.points) ? entry.points : [];
      points.forEach((point) => {
        const normalized = normalizePoint(point);
        if (!normalized) return;
        series.points.push(normalized);
      });
    });

    (Array.isArray(uplinks) ? uplinks : []).forEach((uplink) => {
      if (!uplink) return;
      const interfaceRaw = uplink.interface || uplink.name || uplink.wan || null;
      const key = toInterfaceKey(interfaceRaw);
      const statusLabel = uplink.status || uplink.reachability || uplink.statusNormalized || 'unknown';
      const normalizedStatus = normalizeStatus(statusLabel, { defaultStatus: statusLabel || 'unknown', forPort: true });
      const series = upsertSeries(key, {
        interface: interfaceRaw || 'WAN',
        serial: uplink.serial || serialHint || null,
        statusHint: statusLabel,
      });

      const down = uplink.rxKbps ?? uplink.downstreamKbps ?? uplink.receive ?? uplink.usageInKbps ?? uplink.downloadKbps ?? null;
      const up = uplink.txKbps ?? uplink.upstreamKbps ?? uplink.send ?? uplink.uploadKbps ?? null;
      const total = (down != null || up != null) ? (down || 0) + (up || 0) : null;

      const nowPoint = {
        timestamp: nowIso,
        status: statusLabel,
        statusNormalized: normalizedStatus,
      };
      if (down != null) nowPoint.rxKbps = down;
      if (up != null) nowPoint.txKbps = up;
      if (total != null) nowPoint.totalKbps = total;

      const existingIndex = series.points.findIndex((point) => {
        if (!point?.timestamp) return false;
        return new Date(point.timestamp).getTime() === safeNowMs;
      });
      if (existingIndex >= 0) {
        series.points[existingIndex] = { ...series.points[existingIndex], ...nowPoint };
      } else {
        series.points.push(nowPoint);
      }
    });

    const ensureTwoPoints = (series) => {
      const byTimestamp = new Map();
      series.points.forEach((point) => {
        const normalized = normalizePoint(point);
        if (!normalized) return;
        byTimestamp.set(normalized.timestamp, normalized);
      });

      const ordered = Array.from(byTimestamp.values()).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      if (!ordered.length) {
        const fallbackStatus = series._statusHint || 'unknown';
        const normalizedStatus = normalizeStatus(fallbackStatus, { defaultStatus: fallbackStatus, forPort: true });
        ordered.push({ timestamp: startIso, status: fallbackStatus, statusNormalized: normalizedStatus });
        ordered.push({ timestamp: nowIso, status: fallbackStatus, statusNormalized: normalizedStatus });
      } else {
        const first = ordered[0];
        const last = ordered[ordered.length - 1];
        const firstTs = new Date(first.timestamp).getTime();
        const lastTs = new Date(last.timestamp).getTime();
        const firstStatus = first.status || first.statusNormalized || series._statusHint || 'unknown';
        const normalizedFirst = normalizeStatus(firstStatus, { defaultStatus: firstStatus, forPort: true });
        if (!first.statusNormalized) first.statusNormalized = normalizedFirst;
        if (firstTs > startMs) {
          ordered.unshift({
            timestamp: startIso,
            status: first.status || series._statusHint || 'unknown',
            statusNormalized: normalizedFirst,
            rxKbps: first.rxKbps ?? null,
            txKbps: first.txKbps ?? null,
            totalKbps: first.totalKbps ?? null,
          });
        }

        const lastStatus = last.status || last.statusNormalized || series._statusHint || 'unknown';
        const normalizedLast = normalizeStatus(lastStatus, { defaultStatus: lastStatus, forPort: true });
        if (!last.statusNormalized) last.statusNormalized = normalizedLast;
        if (lastTs < safeNowMs) {
          ordered.push({
            timestamp: nowIso,
            status: last.status || series._statusHint || 'unknown',
            statusNormalized: normalizedLast,
            rxKbps: last.rxKbps ?? null,
            txKbps: last.txKbps ?? null,
            totalKbps: last.totalKbps ?? null,
          });
        } else if (lastTs !== safeNowMs) {
          ordered.push({
            ...last,
            timestamp: nowIso,
          });
        }
      }

      if (ordered.length === 1) {
        const only = ordered[0];
        const statusLabel = only.status || only.statusNormalized || series._statusHint || 'unknown';
        const normalizedStatus = normalizeStatus(statusLabel, { defaultStatus: statusLabel, forPort: true });
        if (!only.statusNormalized) only.statusNormalized = normalizedStatus;
        ordered.push({
          timestamp: nowIso,
          status: statusLabel,
          statusNormalized: normalizedStatus,
          rxKbps: only.rxKbps ?? null,
          txKbps: only.txKbps ?? null,
          totalKbps: only.totalKbps ?? null,
        });
      }

      series.points = ordered;
      if (!series.health) {
        series.health = cloneHealth();
      }
    };

    seriesMap.forEach((series) => {
      ensureTwoPoints(series);
      delete series._statusHint;
    });

    return Array.from(seriesMap.values());
  };

  const ensureApplianceAnchors = (graph = {}, { appliances = [], switchesList = [], statusLookup = new Map() } = {}) => {
    const baseNodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    const baseLinks = Array.isArray(graph.links) ? graph.links : [];
    const nodes = baseNodes.map((node) => {
      if (!node) return node;
      const id = node.id || node.serial;
      return id ? { ...node, id } : node;
    }).filter(Boolean);
    const links = [...baseLinks];

  const nodeMap = new Map(nodes.map((node) => [node.id || node.serial, node]));
    const linkSet = new Set(links.map((link) => {
      if (!link) return null;
      const source = link.source || link.from;
      const target = link.target || link.to;
      if (!source || !target) return null;
      return [source, target].sort().join('__');
    }).filter(Boolean));

  const resolveSwitchAnchor = () => {
      for (const sw of switchesList) {
        const serial = sw?.serial;
        if (serial && nodeMap.has(serial)) return serial;
      }
      const typedNode = nodes.find((node) => {
        const text = `${node.label || ''} ${node.model || ''} ${node.type || ''}`.toLowerCase();
        return text.includes('switch') || text.includes(' ms');
      });
      if (typedNode) return typedNode.id;
      return nodes[0]?.id || null;
    };

    const anchorId = resolveSwitchAnchor();
    appliances.forEach((device) => {
      const serial = device?.serial;
      if (!serial) return;

      const normalizedStatus = statusLookup.get(serial) || device.status || 'unknown';
      const model = device.model || '';
      const lowerModel = model.toLowerCase();
      const type = lowerModel.startsWith('mx') || lowerModel.includes('security appliance')
        ? 'mx'
        : (lowerModel.includes('utm') || lowerModel.startsWith('z3') ? 'utm' : 'device');
      const label = device.name || model || serial;

      if (!nodeMap.has(serial)) {
        const newNode = {
          id: serial,
          serial,
          label,
          type,
          model,
          mac: device.mac || null,
          status: normalizedStatus
        };
        nodes.push(newNode);
        nodeMap.set(serial, newNode);
      } else {
        const existing = nodeMap.get(serial) || {};
        const updated = {
          ...existing,
          id: serial,
          serial,
          status: normalizedStatus,
          model: model || existing.model,
          mac: device.mac || existing.mac || null,
          type: type !== 'device' ? type : (existing.type || type),
          label: (!existing.label || existing.label === existing.serial || existing.label === serial) ? label : existing.label
        };
        nodeMap.set(serial, updated);
      }

      if (!anchorId || anchorId === serial) return;
      const key = [serial, anchorId].sort().join('__');
      if (linkSet.has(key)) return;
      const status = normalizedStatus || statusLookup.get(anchorId) || 'unknown';
      links.push({ source: serial, target: anchorId, status });
      linkSet.add(key);
    });

    const updatedNodes = Array.from(nodeMap.values());
    return { ...graph, nodes: updatedNodes, links };
  };

  const pickUplinkAddressDetails = (entry, interfaceName) => {
    if (!entry || typeof entry !== 'object') return null;
    const candidates = [];
    const resolved = resolveUplinkAddressKey(interfaceName);
    if (resolved) candidates.push(resolved);
    if (!candidates.includes('wan1')) candidates.push('wan1');
    if (!candidates.includes('wan2')) candidates.push('wan2');
    if (!candidates.includes('cellular')) candidates.push('cellular');
    if (!candidates.includes('wan3')) candidates.push('wan3');
    for (const key of candidates) {
      const details = entry[key];
      if (details && typeof details === 'object') {
        return { key, details };
      }
    }
    return null;
  };

  try {
  logger.info(`Iniciando carga paralela para ${networkId}`);
    const orgId = await resolveNetworkOrgId(networkId);
    if (!orgId) {
      throw new Error(`No se pudo resolver la organizationId para el network ${networkId}`);
    }

    const [
      networkInfoRes,
      devicesRes,
      topologyRes,
      deviceStatusesRes
    ] = await Promise.allSettled([
      getNetworkInfo(networkId),
      getNetworkDevices(networkId),
      getNetworkTopologyLinkLayer(networkId),
      getOrganizationDevicesStatuses(orgId, { 'networkIds[]': networkId })
    ]);

    const networkInfo = networkInfoRes.status === 'fulfilled' ? networkInfoRes.value : null;
    const devices = devicesRes.status === 'fulfilled' ? (devicesRes.value || []) : [];
    const switches = devices.filter((d) => d.model?.toLowerCase().startsWith('ms'));
    const mxDevice = devices.find((d) => d.model?.toLowerCase().startsWith('mx') || (d.model || '').toLowerCase().includes('utm'));
    const accessPoints = devices.filter((d) => (d.model || '').toLowerCase().startsWith('mr'));

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const withRetries = async (fn, { label = 'operaci├│n', maxAttempts = 3, baseDelay = 600, maxDelay = 6000 } = {}) => {
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          return await fn();
        } catch (error) {
          const status = error?.response?.status;
          if (status === 429 && attempt < maxAttempts - 1) {
            const waitMs = Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
            logger.warn(`L├¡mite de peticiones ${label} (intento ${attempt + 1}/${maxAttempts}). Reintentando en ${waitMs}ms`);
            await sleep(waitMs);
            continue;
          }
          throw error;
        }
      }
      return null;
    };

    // Optimizaci├│n LLDP/CDP: reutilizar cach├® por network, paralelizar por lotes y l├¡mite de concurrencia
    let lldpSnapshots = {};
    // Intentar reutilizar cach├® por network si existe (permitir bypass con forceLldpRefresh)
    const cachedLldp = !forceLldpRefresh && getFromCache(cache.lldpByNetwork, networkId, 'lldp');
    if (forceLldpRefresh) {
      logger.info(`Bypass cach├® LLDP/CDP solicitado para ${networkId} (forceLldpRefresh)`);
    }
    if (cachedLldp) {
      logger.info(`Usando cach├® LLDP/CDP para ${networkId} (${Object.keys(cachedLldp).length} entradas)`);
      lldpSnapshots = { ...cachedLldp };
    } else {
      const lldpCache = {};
      const devicesToScan = [...switches, ...accessPoints];
      const CONCURRENCY_LIMIT = 8; // Puedes ajustar este valor
      async function getLldpCdpWithCache(serial) {
        if (lldpCache[serial]) return lldpCache[serial];
        const info = await withRetries(() => getDeviceLldpCdp(serial), { label: `LLDP/CDP ${serial}`, maxAttempts: 4, baseDelay: 700 });
        if (info) lldpCache[serial] = info;
        return info;
      }
      async function parallelLldpCdp(devices, limit = CONCURRENCY_LIMIT) {
        const results = {};
        let idx = 0;
        while (idx < devices.length) {
          const batch = devices.slice(idx, idx + limit);
          const promises = batch.map(device => getLldpCdpWithCache(device.serial)
            .then(info => ({ serial: device.serial, info }))
            .catch(error => ({ serial: device.serial, error })));
          const settled = await Promise.allSettled(promises);
          for (const result of settled) {
            if (result.status === 'fulfilled') {
              const { serial, info, error } = result.value;
              if (info) {
                lldpSnapshots[serial] = info;
              } else if (error) {
                const status = error?.response?.status;
                const message = error?.response?.data || error?.message;
                const detail = [status, message].filter(Boolean).join(' ');
                logger.warn(`LLDP/CDP no disponible para ${serial}: ${detail}`);
              }
            } else {
              const { serial } = result.reason || {};
              logger.warn(`LLDP/CDP no disponible para ${serial}: ${result.reason}`);
            }
          }
          idx += limit;
        }
      }
      if (devicesToScan.length) {
        logger.info(`Obteniendo LLDP/CDP para ${devicesToScan.length} dispositivos (switches + APs) en paralelo (l├¡mite ${CONCURRENCY_LIMIT})...`);
        await parallelLldpCdp(devicesToScan, CONCURRENCY_LIMIT);
      }

      // Guardar snapshot en cach├® si obtuvimos datos
      try {
        if (Object.keys(lldpSnapshots).length) {
          setInCache(cache.lldpByNetwork, networkId, lldpSnapshots, 'lldp');
          logger.info(`Cach├® LLDP/CDP guardada para ${networkId} (${Object.keys(lldpSnapshots).length} entradas)`);
        }
      } catch (e) {
        logger.warn('Error guardando cach├® LLDP/CDP:', e?.message || e);
      }
    }

    const lowercase = (value) => (value || '').toString().toLowerCase();
    const deviceProfile = devices.reduce((acc, device) => {
      const model = lowercase(device.model);
      if (model.startsWith('ms')) acc.switches += 1;
      else if (model.startsWith('mr')) acc.accessPoints += 1;
      else if (model.startsWith('mx') || model.includes('utm') || model.includes('appliance')) acc.appliances += 1;
      else if (model.startsWith('z')) acc.teleworkers += 1;
      else acc.others += 1;
      return acc;
    }, { total: devices.length, switches: 0, accessPoints: 0, appliances: 0, teleworkers: 0, others: 0 });

    const guessNetworkFlavor = () => {
      const tags = Array.isArray(networkInfo?.tags) ? networkInfo.tags.map((tag) => tag.toUpperCase()) : [];
      const nameCaps = (networkInfo?.name || '').toUpperCase();
      const hasTag = (tag) => tags.includes(tag);

      if (hasTag('USAP') || nameCaps.includes('USAP')) return 'USAP';
      if (hasTag('GSAP') || nameCaps.includes('GSAP')) return 'GSAP';
      if (hasTag('GAP') || nameCaps.includes('GAP')) return 'GAP';
      if (hasTag('GTW') || nameCaps.includes('GTW')) return 'GTW';

      const modelsCaps = devices.map((device) => (device.model || '').toString().toUpperCase());
      const hasZSeries = modelsCaps.some((model) => model.startsWith('Z'));
      const hasMX84 = modelsCaps.some((model) => model.includes('MX84'));
      const hasMX85 = modelsCaps.some((model) => model.includes('MX85'));
      const hasMxAppliance = modelsCaps.some((model) => model.startsWith('MX'));
      const hasTeleworkerGateway = hasZSeries || hasMX84 || deviceProfile.teleworkers > 0;
      const hasUtmGateway = hasMX85 || hasMX84 || hasMxAppliance || deviceProfile.appliances > 0;
      const hasSwitches = deviceProfile.switches > 0;
      const hasMultipleSwitches = deviceProfile.switches > 1;
      const hasAps = deviceProfile.accessPoints > 0;

      if (hasTeleworkerGateway && hasSwitches && hasAps) {
        return hasMultipleSwitches ? 'USAP' : 'GSAP';
      }

      if (hasUtmGateway && !hasSwitches && hasAps) {
        return 'GAP';
      }

      if (hasUtmGateway && !hasSwitches && !hasAps) {
        return 'GTW';
      }

      if (hasMultipleSwitches && hasAps) return 'USAP';
      if (hasSwitches && hasAps) return 'GSAP';
      if (hasUtmGateway && hasAps) return 'GAP';
      if (hasUtmGateway && !hasAps) return 'GTW';

      return null;
    };

    const networkFlavor = guessNetworkFlavor();
    const teleworkerDevices = devices.filter((d) => lowercase(d.model).startsWith('z'));
    const utmDevices = devices.filter((d) => lowercase(d.model).includes('utm'));
    const mxModelLower = lowercase(mxDevice?.model);
    const predioInfo = getPredioInfoForNetwork(networkId);
    const coverageName = predioInfo?.predio_name || predioInfo?.predioName || predioInfo?.nombre_predio || predioInfo?.name || networkInfo?.name || null;
    const shouldFetchSwitchData = switches.length > 0;
    const shouldFetchApplianceData = Boolean(mxDevice);
    const networkMetadata = {
      networkInfo: networkInfo ? {
        id: networkInfo.id,
        name: networkInfo.name,
        productTypes: networkInfo.productTypes,
        tags: networkInfo.tags,
        timezone: networkInfo.timezone,
        notes: networkInfo.notes,
      } : null,
      organizationId: orgId,
      deviceProfile,
      predioInfo,
      coverageName,
      networkFlavor,
      counts: {
        totalDevices: devices.length,
        switches: deviceProfile.switches,
        accessPoints: deviceProfile.accessPoints,
        appliances: deviceProfile.appliances,
        teleworkers: teleworkerDevices.length,
        others: deviceProfile.others,
      },
    };
    const optionalTasks = [];
    const addTask = (key, promise) => {
      if (!promise || typeof promise.then !== 'function') return;
      optionalTasks.push({ key, promise });
    };

    // SIEMPRE cargar datos completos (eliminado modo r├ípido)
    if (shouldFetchSwitchData) {
      addTask('switchPorts', getNetworkSwitchPortsStatuses(networkId));
    }

    // Agregar datos wireless para visualizar microcortes en conectividad
    if (orgId && accessPoints.length) {
      const wirelessParams = { 'networkIds[]': networkId, timespan: DEFAULT_WIRELESS_TIMESPAN };
      
      // Cachear endpoints wireless críticos para evitar rate limiting en predios grandes
      const cacheKeyEthernet = `${orgId}:${networkId}:ethernet`;
      const cacheKeyFailed = `${networkId}:failed:${DEFAULT_WIRELESS_TIMESPAN}`;
      const cacheKeySignal = `${orgId}:${networkId}:signal:${DEFAULT_WIRELESS_TIMESPAN}`;
      
      // Ethernet statuses con caché agresivo (15 min TTL)
      const cachedEthernet = getFromCache(cache.wirelessEthernetStatuses, cacheKeyEthernet, 'wirelessEthernetStatuses');
      if (cachedEthernet) {
        logger.debug(`[Cache] Usando ethernet statuses cacheados para ${networkId} (${cachedEthernet.length} APs)`);
        addTask('wirelessEthernetStatuses', Promise.resolve(cachedEthernet));
      } else {
        addTask('wirelessEthernetStatuses', 
          getOrgWirelessDevicesEthernetStatuses(orgId, { 'networkIds[]': networkId })
            .then(data => {
              if (data && data.length > 0) {
                setInCache(cache.wirelessEthernetStatuses, cacheKeyEthernet, data, 'wirelessEthernetStatuses');
                logger.debug(`[Cache] Guardado ethernet statuses para ${networkId} (${data.length} APs, TTL 15min)`);
              }
              return data;
            })
        );
      }
      
      // Failed connections con caché (10 min TTL) - rehabilitado con caché
      const cachedFailed = getFromCache(cache.wirelessFailedConnections, cacheKeyFailed, 'wirelessFailedConnections');
      if (cachedFailed) {
        logger.debug(`[Cache] Usando failed connections cacheados para ${networkId} (${cachedFailed.length} eventos)`);
        addTask('wirelessFailedConnections', Promise.resolve(cachedFailed));
      } else {
        addTask('wirelessFailedConnections', 
          getNetworkWirelessFailedConnections(networkId, { timespan: DEFAULT_WIRELESS_TIMESPAN })
            .then(data => {
              const dataArray = Array.isArray(data) ? data : [];
              if (dataArray.length > 0) {
                setInCache(cache.wirelessFailedConnections, cacheKeyFailed, dataArray, 'wirelessFailedConnections');
                logger.debug(`[Cache] Guardado failed connections para ${networkId} (${dataArray.length} eventos, TTL 10min)`);
              }
              return dataArray;
            })
        );
      }
      
      // Signal quality con caché (8 min TTL)
      const cachedSignal = getFromCache(cache.wirelessSignalQuality, cacheKeySignal, 'wirelessSignalQuality');
      if (cachedSignal) {
        logger.debug(`[Cache] Usando signal quality cacheado para ${networkId}`);
        addTask('wirelessSignalByDevice', Promise.resolve(cachedSignal.byDevice || []));
        addTask('wirelessSignalHistory', Promise.resolve(cachedSignal.history || []));
      } else {
        addTask('wirelessSignalByDevice', 
          getOrgWirelessSignalQualityByDevice(orgId, wirelessParams)
            .then(data => {
              if (data) {
                const existing = getFromCache(cache.wirelessSignalQuality, cacheKeySignal, 'wirelessSignalQuality') || {};
                setInCache(cache.wirelessSignalQuality, cacheKeySignal, { ...existing, byDevice: data }, 'wirelessSignalQuality');
              }
              return data;
            })
        );
        addTask('wirelessSignalHistory', 
          getNetworkWirelessSignalQualityHistory(networkId, { timespan: DEFAULT_WIRELESS_TIMESPAN, resolution: 600 })
            .then(data => {
              if (data) {
                const existing = getFromCache(cache.wirelessSignalQuality, cacheKeySignal, 'wirelessSignalQuality') || {};
                setInCache(cache.wirelessSignalQuality, cacheKeySignal, { ...existing, history: data }, 'wirelessSignalQuality');
                logger.debug(`[Cache] Guardado signal quality para ${networkId} (TTL 8min)`);
              }
              return data;
            })
        );
      }
    }

    if (shouldFetchApplianceData) {
      addTask('applianceStatuses', getApplianceStatuses(networkId));
      addTask('appliancePorts', getAppliancePorts(networkId));
      addTask('appliancePerformance', getAppliancePerformance(networkId, 3600));
      addTask('applianceConnectivity', getNetworkApplianceConnectivityMonitoringDestinations(networkId));
      addTask('applianceSecurity', getApplianceClientSecurity(networkId));
      addTask('applianceTraffic', getApplianceTrafficShaping(networkId));
      addTask('applianceBandwidth', getNetworkClientsBandwidthUsage(networkId, 3600));
      addTask('applianceSecurityOrg', getOrganizationApplianceSecurityIntrusion(orgId));
      addTask('applianceSecurityMalware', getNetworkApplianceSecurityMalware(networkId));
      addTask('organizationUplinksStatuses', getOrganizationUplinksStatuses(orgId, { 'networkIds[]': networkId }));
      if (mxDevice) {
        addTask('appliancePortStatuses', withRetries(() => getDeviceAppliancePortsStatuses(mxDevice.serial), { label: `puertos appliance ${mxDevice.serial}`, maxAttempts: 4, baseDelay: 700 }));
        addTask('applianceUplinkHistory', withRetries(() => getOrgApplianceUplinksLossAndLatency(orgId, { 'networkIds[]': networkId, timespan: uplinkTimespan, resolution: uplinkResolution }), { label: `historial uplinks ${networkId}`, maxAttempts: 3, baseDelay: 900 }));
        addTask('applianceUplinkUsage', withRetries(() => getOrgApplianceUplinksUsageByDevice(orgId, { 'networkIds[]': networkId, timespan: uplinkTimespan, resolution: uplinkResolution }), { label: `uso uplinks ${networkId}`, maxAttempts: 3, baseDelay: 900 }));
      }
    }

    if (!shouldFetchApplianceData && teleworkerDevices.length) {
      addTask('appliancePorts', getAppliancePorts(networkId));
      teleworkerDevices.forEach((device, index) => {
          const serial = device?.serial;
          const keySuffix = serial || `idx${index}`;
          const baseKey = `teleworker:${keySuffix}`;
          if (serial) {
            addTask(`${baseKey}:portStatuses`, withRetries(() => getDeviceAppliancePortsStatuses(serial), { label: `puertos teleworker ${serial}`, maxAttempts: 4, baseDelay: 700 }));
            addTask(`${baseKey}:deviceUplink`, withRetries(() => getDeviceUplink(serial), { label: `uplink device ${serial}`, maxAttempts: 4, baseDelay: 700 }));
            addTask(`${baseKey}:orgUplinks`, withRetries(() => getOrgApplianceUplinksStatuses(orgId, { 'serials[]': serial }), { label: `uplinks org ${serial}`, maxAttempts: 4, baseDelay: 900 }));
            addTask(`${baseKey}:uplinkHistory`, withRetries(() => getOrgApplianceUplinksLossAndLatency(orgId, { 'serials[]': serial, timespan: uplinkTimespan, resolution: uplinkResolution }), { label: `historial uplinks ${serial}`, maxAttempts: 3, baseDelay: 900 }));
            addTask(`${baseKey}:uplinkUsage`, withRetries(() => getOrgApplianceUplinksUsageByDevice(orgId, { 'serials[]': serial, timespan: uplinkTimespan, resolution: uplinkResolution }), { label: `uso uplinks ${serial}`, maxAttempts: 3, baseDelay: 900 }));
          }
        });
    }

    if (orgId && (shouldFetchApplianceData || teleworkerDevices.length)) {
      addTask('applianceUplinkAddresses', getOrgDevicesUplinksAddressesByDevice(orgId, { 'networkIds[]': networkId }));
    }

    if (orgId && accessPoints.length) {
      const wirelessParams = { 'networkIds[]': networkId, timespan: DEFAULT_WIRELESS_TIMESPAN };
      addTask('wirelessSignalByClient', getOrgWirelessSignalQualityByClient(orgId, wirelessParams));
      addTask('wirelessSignalByNetwork', getOrgWirelessSignalQualityByNetwork(orgId, { timespan: DEFAULT_WIRELESS_TIMESPAN }));
    }

    let optionalResults = {};
    if (optionalTasks.length) {
      const settled = await Promise.allSettled(optionalTasks.map((task) => task.promise));
      optionalResults = optionalTasks.reduce((acc, task, index) => {
        acc[task.key] = settled[index];
        return acc;
      }, {});
    }

    const rawTopology = topologyRes.status === 'fulfilled' ? topologyRes.value : null;
    const deviceStatuses = deviceStatusesRes.status === 'fulfilled' ? (deviceStatusesRes.value || []) : [];

    let switchPortStatuses = optionalResults.switchPorts?.status === 'fulfilled' ? (optionalResults.switchPorts.value || []) : [];
    if (!Array.isArray(switchPortStatuses)) switchPortStatuses = [];

    const configBySerial = new Map();
    if (switches.length) {
      for (const sw of switches) {
        const serialUpper = (sw.serial || '').toUpperCase();
        try {
          const configData = await withRetries(() => getDeviceSwitchPorts(sw.serial), { label: `configuraci├│n puertos ${sw.serial}`, maxAttempts: 4, baseDelay: 700 });
          const entries = Array.isArray(configData) ? configData : [];
          const map = new Map();
          entries.forEach((item) => {
            const portKey = item.portId ?? item.number ?? item.port ?? item.portNumber;
            if (portKey === undefined || portKey === null) return;
            map.set(portKey.toString(), item);
          });
          configBySerial.set(serialUpper, { serial: sw.serial, map });
        } catch (error) {
          const message = error?.response?.data || error?.message;
          logger.warn(`Configuraci├│n de puertos no disponible para ${sw.serial}: ${message}`);
          configBySerial.set(serialUpper, { serial: sw.serial, map: new Map() });
        }
      }
    }

    if (!switchPortStatuses.length && switches.length) {
      const fallbackStatuses = [];
      for (const sw of switches) {
        try {
          const statusData = await withRetries(() => getDeviceSwitchPortsStatuses(sw.serial), { label: `estados puertos ${sw.serial}`, maxAttempts: 4, baseDelay: 700 });
          if (Array.isArray(statusData)) {
            statusData.forEach((item) => {
              fallbackStatuses.push({
                ...item,
                serial: item.serial || item.switchSerial || item.deviceSerial || sw.serial,
                switchSerial: sw.serial
              });
            });
          }
        } catch (error) {
          const message = error?.response?.data || error?.message;
          logger.warn(`Estados de puertos no disponibles para ${sw.serial}: ${message}`);
        }
      }
      switchPortStatuses = fallbackStatuses;
    }

    let switchPorts = [];
    const seenPortKeys = new Set();

    switchPortStatuses.forEach((status) => {
      const serialRaw = status.serial || status.switchSerial || status.deviceSerial || status.device?.serial || '';
      const serialUpper = serialRaw ? serialRaw.toString().toUpperCase() : '';
      const portKey = status.portId ?? status.number ?? status.port ?? status.portNumber;
      const portKeyStr = portKey != null ? portKey.toString() : null;

      let merged = status;
      if (serialUpper && portKeyStr) {
        const configEntry = configBySerial.get(serialUpper);
        const configMap = configEntry?.map;
        if (configMap && configMap.has(portKeyStr)) {
          const configData = configMap.get(portKeyStr);
          merged = { ...configData, ...status };
          configMap.delete(portKeyStr);
        }
      }

      const serialForNormalize = serialRaw || configBySerial.get(serialUpper)?.serial || serialUpper || null;
      const normalized = normalizeSwitchPort(serialForNormalize, merged);
      if (normalized) {
        const dedupKey = `${(normalized.serial || '').toUpperCase()}:${normalized.portId}`;
        if (!seenPortKeys.has(dedupKey)) {
          seenPortKeys.add(dedupKey);
          switchPorts.push(normalized);
        }
      }
    });

    configBySerial.forEach(({ serial, map }, serialUpper) => {
      map.forEach((configData) => {
        const normalized = normalizeSwitchPort(serial || serialUpper, configData);
        if (normalized) {
          const dedupKey = `${(normalized.serial || '').toUpperCase()}:${normalized.portId}`;
          if (!seenPortKeys.has(dedupKey)) {
            seenPortKeys.add(dedupKey);
            switchPorts.push(normalized);
          }
        }
      });
    });

    if (!switchPorts.length && switches.length) {
  logger.warn(`No se pudieron obtener datos de puertos para los switches de ${networkId}`);
    }

    let applianceUplinks = [];
    if (optionalResults.applianceStatuses?.status === 'fulfilled') {
      applianceUplinks = normalizeApplianceUplinks(optionalResults.applianceStatuses.value, { serial: mxDevice?.serial });
    }

    let appliancePorts = [];
    let appliancePortSummary = null;
    let appliancePortConfigs = [];
    if (optionalResults.appliancePorts?.status === 'fulfilled' && Array.isArray(optionalResults.appliancePorts.value)) {
      appliancePortConfigs = optionalResults.appliancePorts.value;
    }

    const appliancePortStatusesRaw = optionalResults.appliancePortStatuses?.status === 'fulfilled' ? optionalResults.appliancePortStatuses.value : [];

    if ((Array.isArray(appliancePortConfigs) && appliancePortConfigs.length) || (Array.isArray(appliancePortStatusesRaw) && appliancePortStatusesRaw.length)) {
  appliancePorts = mergeAppliancePorts(appliancePortConfigs, appliancePortStatusesRaw, applianceUplinks);
      appliancePortSummary = summarizeAppliancePorts(appliancePorts);
    }

    const appliancePerformance = optionalResults.appliancePerformance?.status === 'fulfilled' ? optionalResults.appliancePerformance.value : null;
    const applianceConnectivity = optionalResults.applianceConnectivity?.status === 'fulfilled' ? (optionalResults.applianceConnectivity.value || []) : [];
    const applianceSecurity = optionalResults.applianceSecurity?.status === 'fulfilled' ? optionalResults.applianceSecurity.value : null;
    const applianceSecurityOrg = optionalResults.applianceSecurityOrg?.status === 'fulfilled' ? optionalResults.applianceSecurityOrg.value : null;
    const applianceSecurityMalware = optionalResults.applianceSecurityMalware?.status === 'fulfilled' ? optionalResults.applianceSecurityMalware.value : null;
    const applianceTraffic = optionalResults.applianceTraffic?.status === 'fulfilled' ? optionalResults.applianceTraffic.value : null;
    const applianceBandwidth = optionalResults.applianceBandwidth?.status === 'fulfilled' ? optionalResults.applianceBandwidth.value : [];
    const applianceUplinkHistoryRaw = optionalResults.applianceUplinkHistory?.status === 'fulfilled' ? optionalResults.applianceUplinkHistory.value : [];
    const applianceUplinkUsageRaw = optionalResults.applianceUplinkUsage?.status === 'fulfilled' ? optionalResults.applianceUplinkUsage.value : [];
  const organizationUplinksRaw = optionalResults.organizationUplinksStatuses?.status === 'fulfilled' ? optionalResults.organizationUplinksStatuses.value : [];
  const uplinkAddressesRaw = optionalResults.applianceUplinkAddresses?.status === 'fulfilled' ? optionalResults.applianceUplinkAddresses.value : [];

    const baseElapsed = Date.now() - startTime;
  logger.info(`Carga base completada en ${baseElapsed}ms`);

    const statusMap = new Map();
    const statusDetailMap = new Map();
    deviceStatuses.forEach((item) => {
      if (item?.serial) {
        const normalized = normalizeStatus(item.status || item.reachability || item.connectionStatus, { defaultStatus: item.status || item.reachability || 'unknown' });
        statusMap.set(item.serial, normalized);
        statusDetailMap.set(item.serial, {
          rawStatus: item.status || item.reachability || item.connectionStatus,
          lastReportedAt: item.lastReportedAt,
          connection: normalized
        });
      }
    });

    devices.forEach((device) => {
      if (!device?.serial) return;
      const normalizedStatus = statusMap.get(device.serial);
      if (normalizedStatus) {
        device.status = normalizedStatus;
      }
      const detail = statusDetailMap.get(device.serial);
      if (detail?.lastReportedAt) {
        device.lastReportedAt = detail.lastReportedAt;
      }
    });

    const wirelessSignalByDeviceRaw = optionalResults.wirelessSignalByDevice?.status === 'fulfilled' ? optionalResults.wirelessSignalByDevice.value : [];
    const wirelessSignalHistoryRaw = optionalResults.wirelessSignalHistory?.status === 'fulfilled' ? optionalResults.wirelessSignalHistory.value : [];
    const wirelessSignalByClientRaw = optionalResults.wirelessSignalByClient?.status === 'fulfilled' ? optionalResults.wirelessSignalByClient.value : [];
    const wirelessSignalByNetworkRaw = optionalResults.wirelessSignalByNetwork?.status === 'fulfilled' ? optionalResults.wirelessSignalByNetwork.value : [];
    const wirelessEthernetStatusesRaw = optionalResults.wirelessEthernetStatuses?.status === 'fulfilled' ? optionalResults.wirelessEthernetStatuses.value : [];

    const ethernetStatusMap = new Map();
    const registerEthernetEntry = (serial, value) => {
      if (!serial || !value) return;
      const upper = serial.toString().toUpperCase();
      if (!upper) return;
      ethernetStatusMap.set(upper, value);
      const compact = upper.replace(/-/g, '');
      if (compact && compact !== upper) {
        ethernetStatusMap.set(compact, value);
      }
    };
    if (Array.isArray(wirelessEthernetStatusesRaw)) {
      wirelessEthernetStatusesRaw.forEach((entry) => registerEthernetEntry(entry?.serial, entry));
    }
    logger.debug(`Ethernet status - Total registrados: ${ethernetStatusMap.size}, APs a enriquecer: ${accessPoints.length}`);
    
    // Procesar failedConnections correctamente desde Promise.allSettled
    const wirelessFailedConnectionsRaw = optionalResults.wirelessFailedConnections?.status === 'fulfilled' ? optionalResults.wirelessFailedConnections.value : [];
  logger.debug(`Detalles wireless - failedConnections estado: ${optionalResults.wirelessFailedConnections?.status}, tipo de valor: ${typeof wirelessFailedConnectionsRaw}, esArray: ${Array.isArray(wirelessFailedConnectionsRaw)}, longitud: ${Array.isArray(wirelessFailedConnectionsRaw) ? wirelessFailedConnectionsRaw.length : 'N/A'}`);

    const wirelessInsights = composeWirelessMetrics({
      accessPoints,
      networkId,
      signalByDeviceRaw: wirelessSignalByDeviceRaw,
      signalHistoryRaw: wirelessSignalHistoryRaw,
      signalByClientRaw: wirelessSignalByClientRaw,
      signalByNetworkRaw: wirelessSignalByNetworkRaw,
      failedConnectionsRaw: wirelessFailedConnectionsRaw,
      timespanSeconds: orgId && accessPoints.length ? DEFAULT_WIRELESS_TIMESPAN : null,
    });
    
  logger.info(`Wireless: insights generados para ${accessPoints.length} APs`);

    const switchesDetailed = switches.map((sw) => {
      const swSerialUpper = (sw.serial || '').toUpperCase();
      const swMacLower = (sw.mac || '').toLowerCase();
      const ports = switchPorts
        .filter((port) => {
          if (!port) return false;
          if (port.serial && port.serial.toUpperCase() === swSerialUpper) return true;
          if (Array.isArray(port.serialAliases) && port.serialAliases.map((alias) => alias.toUpperCase()).includes(swSerialUpper)) return true;
          if (swMacLower && Array.isArray(port.macAliases) && port.macAliases.includes(swMacLower)) return true;
          return false;
        })
        .sort((a, b) => {
          const aNum = Number(a.portId);
          const bNum = Number(b.portId);
          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum - bNum;
          return String(a.portId).localeCompare(String(b.portId));
        });

      const stats = ports.reduce((acc, port) => {
        const statusLabel = (port.statusNormalized || port.status || '').toString().toLowerCase();
        const isEnabled = port.enabled !== false;
        acc.totalPorts += 1;
        if (!isEnabled) {
          acc.disabledPorts += 1;
        } else if (statusLabel === 'connected') {
          acc.connectedPorts += 1;
        } else if (statusLabel === 'disconnected' || statusLabel === 'offline') {
          acc.inactivePorts += 1;
        } else {
          acc.unknownPorts += 1;
        }

        if (port.poeEnabled) {
          acc.poePorts += 1;
          if (isEnabled && statusLabel === 'connected') acc.poeActivePorts += 1;
        }

        if (port.isUplink) {
          acc.uplinkPorts.push({
            portId: port.portId,
            name: port.name,
            status: port.status,
            statusNormalized: port.statusNormalized
          });
        }

        if ((port.type || '').toLowerCase() === 'trunk') acc.trunkPorts += 1;
        if ((port.type || '').toLowerCase() === 'access') acc.accessPorts += 1;
        return acc;
      }, {
        totalPorts: 0,
        connectedPorts: 0,
        inactivePorts: 0,
        disabledPorts: 0,
        unknownPorts: 0,
        poePorts: 0,
        poeActivePorts: 0,
        trunkPorts: 0,
        accessPorts: 0,
        uplinkPorts: []
      });

      // Determinar conexi├│n upstream usando datos LLDP/CDP reales
      let connectedTo = '-';
      let uplinkPortOnRemote = null; // Puerto del dispositivo remoto (appliance o switch)
      let activeUplink = null; // Declarar activeUplink en el scope superior
      let lldpPort = null; // Para saber si se us├│ LLDP
      let linkToMx = null; // Para saber si se us├│ topology fallback
      
      const lldpData = lldpSnapshots[sw.serial];
  logger.debug(`LLDP - ${sw.name}: hasLLDP=${!!lldpData}, uplinkPorts=${stats.uplinkPorts.length}`);
      
      if (lldpData && lldpData.ports) {
  logger.debug(`LLDP - ${sw.name} - puertos detectados: ${Object.keys(lldpData.ports).length}`);
  logger.debug(`Uplink disponibles - ${sw.name}: ${stats.uplinkPorts.map(p => `${p.portId}(${p.status})`).join(', ')}`);
        
        // Buscar el puerto uplink activo en los datos LLDP
        activeUplink = stats.uplinkPorts.find(p => {
          const st = (p.statusNormalized || p.status || '').toLowerCase();
          return st === 'connected' || st === 'online' || st.includes('active');
        });

  logger.debug(`Active uplink - ${sw.name}: ${activeUplink ? `Puerto ${activeUplink.portId}` : 'NINGUNO'}`);

        if (activeUplink) {
          const uplinkPortId = activeUplink.portId.toString();
          
          // La estructura de LLDP es: { '23': {lldp/cdp data}, '24': {...} }
          // Las KEYS son los port IDs, no hay campo portId dentro del objeto
          lldpPort = lldpData.ports[uplinkPortId];
          
          logger.debug(`${sw.name} - Buscando LLDP para uplinkPortId: "${uplinkPortId}"`);
          logger.debug(`${sw.name} - Keys disponibles en lldpData.ports (muestra): ${Object.keys(lldpData.ports).slice(0, 5).join(', ')}`);
          logger.debug(`${sw.name} - Tiene puerto 23?: ${lldpData.ports['23'] ? 'S├ì' : 'NO'}`);
          logger.debug(`${sw.name} - lldpPort para puerto ${uplinkPortId}: ${lldpPort ? 'ENCONTRADO' : 'NO ENCONTRADO'}`);
          
          if (lldpPort) {
            const lldpInfo = lldpPort.lldp || lldpPort.cdp;
            logger.debug(`${sw.name} - lldpInfo: ${lldpInfo ? `${lldpInfo.deviceId || lldpInfo.systemName} port:${lldpInfo.portId || lldpInfo.portDescription}` : 'NO ENCONTRADO'}`);
            
            if (lldpInfo) {
              const remoteName = lldpInfo.deviceId || lldpInfo.systemName || 'Unknown';
              const remotePort = lldpInfo.portId || lldpInfo.portDescription;
              
              logger.debug(`${sw.name} - remoteName: "${remoteName}", remotePort: "${remotePort}"`);
              logger.debug(`${sw.name} - MX device: name=${mxDevice?.name}, serial=${mxDevice?.serial}, model=${mxDevice?.model}`);
              
              // Intentar extraer n├║mero de puerto del remotePort
              const portMatch = remotePort ? remotePort.match(/(\d+)/) : null;
              uplinkPortOnRemote = portMatch ? portMatch[1] : remotePort;
              
              // Verificar si est├í conectado al appliance (buscar por SERIAL y MODELO, no por nombre)
              const isConnectedToAppliance = mxDevice && (
                remoteName.includes(mxDevice.serial) || 
                (mxDevice.model && remoteName.includes(mxDevice.model)) ||
                remoteName.toLowerCase().includes('mx') // Fallback: cualquier MX
              );
              
              logger.debug(`${sw.name} - isConnectedToAppliance=${isConnectedToAppliance}, uplinkPortOnRemote=${uplinkPortOnRemote}`);
              
              if (isConnectedToAppliance && uplinkPortOnRemote) {
                connectedTo = `${mxDevice.name || mxDevice.model}/Port ${uplinkPortOnRemote}`;
              } else if (uplinkPortOnRemote) {
                connectedTo = `${remoteName}/Port ${uplinkPortOnRemote}`;
              } else {
                connectedTo = remoteName;
              }
              
              logger.info(`Switch ${sw.name} puerto ${uplinkPortId} conectado a ${connectedTo}`);
            }
          } else {
            // FALLBACK: Si no hay LLDP del puerto uplink, buscar en topolog├¡a si est├í conectado al MX
            logger.debug(`${sw.name} - Buscando conexi├│n en topolog├¡a de red como fallback`);
            logger.debug(`${sw.name} - rawTopology disponible=${!!rawTopology}, links=${rawTopology?.links?.length || 0}, mxDevice=${!!mxDevice}`);
            
            if (rawTopology && rawTopology.links && mxDevice) {
              // Buscar enlace entre este switch y el MX en la topolog├¡a
              const swSerial = sw.serial.toUpperCase();
              const mxSerial = mxDevice.serial.toUpperCase();
              
              logger.debug(`Buscando enlace entre ${swSerial} y ${mxSerial} en topolog├¡a`);
              logger.debug(`Primer enlace (muestra): ${JSON.stringify(rawTopology.links[0], null, 2)}`);
              logger.debug(`Keys del primer enlace (muestra): ${Object.keys(rawTopology.links[0] || {}).slice(0,5).join(', ')}`);
              
              linkToMx = rawTopology.links.find(link => {
                // La estructura de Meraki usa "ends" array con 2 elementos
                if (!link.ends || !Array.isArray(link.ends) || link.ends.length !== 2) return false;
                
                const end0Serial = link.ends[0]?.device?.serial?.toUpperCase() || '';
                const end1Serial = link.ends[1]?.device?.serial?.toUpperCase() || '';
                
                const matchFound = (end0Serial === swSerial && end1Serial === mxSerial) ||
                                   (end1Serial === swSerial && end0Serial === mxSerial);
                
                if (matchFound) {
                  logger.debug(`Enlace encontrado: ${end0Serial} <-> ${end1Serial}`);
                }
                
                return matchFound;
              });
              
              if (linkToMx) {
                // Determinar cu├íl end es el MX y cu├íl es el switch
                const mxEnd = linkToMx.ends.find(end => end.device?.serial?.toUpperCase() === mxSerial);
                const swEnd = linkToMx.ends.find(end => end.device?.serial?.toUpperCase() === swSerial);
                
                logger.debug(`Enlace MXÔåöSwitch encontrado`);
                logger.debug(`Switch puerto detectado: ${swEnd?.discovered?.lldp?.portId || swEnd?.discovered?.cdp?.portId || 'unknown'}`);
                
                // El MX no responde LLDP, pero podemos obtener el puerto de varias fuentes:
                // 1. Desde organizationUplinksRaw (m├ís confiable)
                // 2. Desde appliancePorts si est├í disponible
                // 3. Inferir por modelo como ├║ltimo recurso
                
                let inferredMxPort = null;
                
                // M├®todo 1: Buscar en organizationUplinksRaw
                if (organizationUplinksRaw && Array.isArray(organizationUplinksRaw)) {
                  // Buscar el uplink del switch actual
                  const switchUplink = organizationUplinksRaw.find(uplink => 
                    uplink.serial?.toUpperCase() === swSerial
                  );
                  
                  if (switchUplink) {
                    // El switch reporta su puerto uplink (ej: "23")
                    const switchUplinkPort = switchUplink.port || switchUplink.uplinkPort || switchUplink.interface;
                    logger.debug(`Switch ${sw.name} reporta uplink en su puerto: ${switchUplinkPort}`);
                    
                    // Ahora buscar el MX para ver qu├® puertos LAN tiene activos
                    const mxUplinks = organizationUplinksRaw.filter(uplink => 
                      uplink.serial?.toUpperCase() === mxSerial && 
                      uplink.networkId === networkId
                    );
                    
                    logger.debug(`MX tiene ${mxUplinks.length} uplinks reportados`);
                    
                    // Los MX reportan sus uplinks WAN, pero la conexi├│n al switch es por puerto LAN
                    // Sin embargo, podemos inferir el puerto LAN buscando en la topolog├¡a procesada
                  }
                }
                
                // M├®todo 2: si no encontramos en uplinks, usar inferencia por modelo
                if (!inferredMxPort) {
                  const model = mxDevice.model || '';
                  if (model.includes('MX64') || model.includes('MX65') || model.includes('MX67')) {
                    inferredMxPort = '3'; // MX64/65/67: primer puerto LAN es 3
                  } else if (model.includes('MX84') || model.includes('MX100')) {
                    inferredMxPort = '10'; // MX84/100: primer puerto LAN suele ser 10
                  } else if (model.includes('MX250') || model.includes('MX450')) {
                    inferredMxPort = '11'; // MX250/450: primer puerto LAN es 11
                  } else {
                    // Fallback gen├®rico: puerto 10
                    inferredMxPort = '10';
                  }
                  logger.debug(`Usando inferencia por modelo ${model} -> Puerto ${inferredMxPort}`);
                }
                
                uplinkPortOnRemote = inferredMxPort;
                connectedTo = `${mxDevice.model}/Port ${uplinkPortOnRemote}`;
                logger.debug(`${sw.name} -> MX Puerto ${uplinkPortOnRemote}`);
              } else {
                logger.debug(`No se encontr├│ enlace entre ${swSerial} y ${mxSerial}`);
              }
            } else {
              logger.debug(`Requisitos no cumplidos para fallback - rawTopology:${!!rawTopology}, links:${!!rawTopology?.links}, mxDevice:${!!mxDevice}`);
            }
          }
        }
      }

      return {
        serial: sw.serial,
        name: sw.name || sw.serial,
        model: sw.model,
        mac: sw.mac,
        lanIp: sw.lanIp,
        status: sw.status,
        lastReportedAt: sw.lastReportedAt,
        tags: sw.tags || [],
        connectedTo,
  uplinkPortOnRemote, // puerto del appliance al que est├í conectado
        stats,
        // Metadata para tooltips
        tooltipInfo: {
          type: 'switch',
          name: sw.name || sw.serial,
          model: sw.model,
          serial: sw.serial,
          mac: sw.mac,
          firmware: sw.firmware,
          lanIp: sw.lanIp,
          status: sw.status,
          totalPorts: stats.totalPorts,
          connectedPorts: stats.connectedPorts,
          poePorts: stats.poePorts,
          poeActivePorts: stats.poeActivePorts,
          uplinkPort: activeUplink?.portId,
          uplinkStatus: activeUplink?.status,
          connectedTo: connectedTo,
          uplinkPortOnRemote: uplinkPortOnRemote,
          detectionMethod: linkToMx ? 'Topology Fallback' : (lldpPort ? 'LLDP/CDP' : 'Unknown')
        },
        ports: ports.map((port) => ({
          portId: port.portId,
          name: port.name,
          enabled: port.enabled,
          status: port.status,
          statusNormalized: port.statusNormalized,
          isUplink: port.isUplink,
          vlan: port.vlan,
          type: port.type,
          speed: port.speed,
          duplex: port.duplex,
          poeEnabled: port.poeEnabled,
          linkNegotiation: port.linkNegotiation
        }))
      };
    });

    const switchesOverview = switchesDetailed.reduce((acc, sw) => {
      acc.totalSwitches += 1;
      acc.totalPorts += sw.stats.totalPorts;
      acc.connectedPorts += sw.stats.connectedPorts;
      acc.inactivePorts += sw.stats.inactivePorts;
      acc.disabledPorts += sw.stats.disabledPorts;
      acc.unknownPorts += sw.stats.unknownPorts;
      acc.poePorts += sw.stats.poePorts;
      acc.poeActivePorts += sw.stats.poeActivePorts;
      acc.uplinkPorts += sw.stats.uplinkPorts.length;
      return acc;
    }, {
      totalSwitches: 0,
      totalPorts: 0,
      connectedPorts: 0,
      inactivePorts: 0,
      disabledPorts: 0,
      unknownPorts: 0,
      poePorts: 0,
      poeActivePorts: 0,
      uplinkPorts: 0
    });

    const merakiGraph = rawTopology ? toGraphFromLinkLayer(rawTopology, statusMap) : { nodes: [], links: [] };
    let topologyGraph = merakiGraph;
    let topologySource = 'meraki-link-layer';
    const hasValidMerakiTopology = (merakiGraph.nodes?.length || 0) > 1 && (merakiGraph.links?.length || 0) > 0;

  logger.info(`Topolog├¡a Meraki - nodos: ${merakiGraph.nodes.length}, enlaces: ${merakiGraph.links.length}`);

    if (!hasValidMerakiTopology) {
  logger.info(`Topolog├¡a Meraki incompleta para ${networkId}, intentando reconstrucci├│n v├¡a LLDP`);
      const cachedLldpMap = getFromCache(cache.lldpByNetwork, networkId, 'lldp') || {};
      // Incluir elementos cacheados primero
      Object.keys(cachedLldpMap).forEach((s) => { if (!lldpSnapshots[s]) lldpSnapshots[s] = cachedLldpMap[s]; });

      const missingDevices = devices.filter((device) => !lldpSnapshots[device.serial]);
      const lldpResults = missingDevices.length
        ? await Promise.allSettled(missingDevices.map((device) => getDeviceLldpCdp(device.serial).catch(() => null)))
        : [];

      lldpResults.forEach((result, idx) => {
        if (result.status === 'fulfilled' && result.value) {
          const device = missingDevices[idx];
          lldpSnapshots[device.serial] = result.value;
        }
      });

      if (Object.keys(lldpSnapshots).length) {
        devices.forEach((device) => {
          if (!device?.model || !device.model.toLowerCase().startsWith('mr')) return;
          fillDeviceConnectionFromLldp(device, lldpSnapshots[device.serial]);
        });
      }

      const fallbackTopology = buildTopologyFromLldp(devices, lldpSnapshots, statusMap);
      if (fallbackTopology.nodes.length || fallbackTopology.links.length) {
        topologyGraph = fallbackTopology;
        topologySource = 'lldp-fallback';
  logger.info(`Topolog├¡a reconstruida v├¡a LLDP para ${networkId}: ${fallbackTopology.nodes.length} nodos, ${fallbackTopology.links.length} enlaces`);
      } else {
        topologyGraph = { nodes: [], links: [] };
        topologySource = 'empty';
  logger.info(`Topolog├¡a vac├¡a para ${networkId} tras intentar LLDP`);
      }
    } else {
  logger.debug(`Topolog├¡a Meraki v├ílida; reconstrucci├│n LLDP omitida`);
    }

    const applianceAnchors = [mxDevice, ...utmDevices].filter(Boolean);
    if (applianceAnchors.length) {
      topologyGraph = ensureApplianceAnchors(topologyGraph, {
        appliances: applianceAnchors,
        switchesList: switches,
        statusLookup: statusMap,
      });
      
      // Limpiar enlaces duplicados del appliance (solo mantener enlace LAN principal)
      topologyGraph = cleanDuplicateApplianceLinks(topologyGraph, applianceAnchors);
    }

    accessPoints.forEach((ap) => {
      const hadData = fillDeviceConnectionFromLldp(ap, lldpSnapshots[ap.serial]);
      if (!hadData && !ap.connectedTo) {
        ap.connectedTo = '-';
      }
      // No asignar fallback aquí - dejar que ethernetStatus lo complete
      const serialUpper = (ap?.serial || '').toString().toUpperCase();
      const ethernetStatus = ethernetStatusMap.get(serialUpper) || ethernetStatusMap.get(serialUpper.replace(/-/g, ''));
      if (ethernetStatus) {
        logger.debug(`AP ${ap.serial} - ethernet RAW:`, JSON.stringify(ethernetStatus));
        
        // Extraer velocidad de la estructura real de Meraki API
        let speedValue = null;
        
        // 1. Intentar desde aggregation.speed (velocidad agregada)
        if (ethernetStatus.aggregation && Number.isFinite(ethernetStatus.aggregation.speed)) {
          speedValue = ethernetStatus.aggregation.speed;
        }
        
        // 2. Intentar desde ports[0].linkNegotiation.speed (primer puerto)
        if (!speedValue && Array.isArray(ethernetStatus.ports) && ethernetStatus.ports.length > 0) {
          const firstPort = ethernetStatus.ports[0];
          if (firstPort.linkNegotiation && Number.isFinite(firstPort.linkNegotiation.speed)) {
            speedValue = firstPort.linkNegotiation.speed;
          }
        }
        
        // 3. Fallback a campos directos (por si cambia la API)
        if (!speedValue) {
          const numericSpeedValue = Number(ethernetStatus.speedMbps || ethernetStatus.linkSpeedMbps || ethernetStatus.speed);
          if (Number.isFinite(numericSpeedValue)) {
            speedValue = numericSpeedValue;
          }
        }
        
        // Formatear velocidad
        let finalSpeed = null;
        if (speedValue) {
          // Convertir a formato legible
          if (speedValue >= 10000) {
            finalSpeed = `${speedValue / 1000} Gbps`;
          } else if (speedValue >= 2500) {
            finalSpeed = '2.5 Gbps';
          } else {
            finalSpeed = `${speedValue} Mbps`;
          }
        } else {
          // Si hay ethernetStatus pero no velocidad, inferir del modelo
          // Si no hay ethernetStatus en absoluto, quedará como null (mostrará '-')
          finalSpeed = inferSpeedFromModel(ap.model) || null;
        }
        
        logger.debug(`AP ${ap.serial} - ethernet: speedValue=${speedValue}, finalSpeed=${finalSpeed}`);
        ap.wiredSpeed = finalSpeed;
        if (ethernetStatus.power || ethernetStatus.powerSource) {
          ap.power = ethernetStatus.power || ethernetStatus.powerSource;
        }
        if (ethernetStatus.duplex || ethernetStatus.duplexMode) {
          ap.duplex = ethernetStatus.duplex || ethernetStatus.duplexMode;
        }
      } else {
        // FALLBACK: Si ethernet status no disponible (429/timeout)
        // Mostrar '-' para indicar que no tenemos datos reales
        // El usuario verá la velocidad real cuando el caché se actualice
        logger.debug(`AP ${ap.serial} - NO ethernet status encontrado, mostrando '-'`);
        ap.wiredSpeed = null;  // null se mostrará como '-' en el frontend
      }
    });

    // Enriquecer wiredSpeed DEBE ocurrir ANTES de buildAccessPointsPayload
    // Ya se hizo arriba después de obtener ethernetStatuses, verificar logs
    
    const summaryAccessPoints = buildAccessPointsPayload({ accessPoints, wirelessInsights });
    
    // Log para debugging de datos wireless
    logger.debug('📊 [Summary] APs construidos:', summaryAccessPoints.length);
    if (summaryAccessPoints.length > 0) {
      const sample = summaryAccessPoints[0];
      logger.debug('📊 [Summary] Sample AP wireless:', {
        serial: sample.serial,
        hasHistory: Array.isArray(sample.wireless?.history) && sample.wireless.history.length > 0,
        historyLength: sample.wireless?.history?.length || 0,
        hasFailureHistory: Array.isArray(sample.wireless?.failureHistory) && sample.wireless.failureHistory.length > 0,
        failureHistoryLength: sample.wireless?.failureHistory?.length || 0,
        wiredSpeed: sample.wiredSpeed,
        microDrops: sample.wireless?.microDrops
      });
    }

    if (shouldFetchApplianceData && !applianceUplinks.length) {
      if (Array.isArray(organizationUplinksRaw) && organizationUplinksRaw.length) {
        applianceUplinks = normalizeApplianceUplinks(organizationUplinksRaw, { serial: mxDevice?.serial });
        if (applianceUplinks.length) {
          logger.info(`Uplinks obtenidos v├¡a endpoint organizacional para ${networkId}`);
        }
      } else if (orgId) {
        try {
          const orgUplinksRaw = await getOrgApplianceUplinksStatuses(orgId, { 'networkIds[]': networkId });
          applianceUplinks = normalizeApplianceUplinks(orgUplinksRaw, { serial: mxDevice?.serial });
          if (applianceUplinks.length) {
            logger.info(`Uplinks obtenidos v├¡a endpoint organizacional para ${networkId}`);
          }
        } catch (err) {
          logger.warn(`Fallback org appliance uplinks fall├│ para ${networkId}: ${err.message}`);
        }
      }
    }

    if (shouldFetchApplianceData && !applianceUplinks.length && mxDevice) {
      try {
        const uplinkFallback = await getDeviceUplink(mxDevice.serial);
    applianceUplinks = normalizeApplianceUplinks(uplinkFallback, { serial: mxDevice.serial });
  logger.info(`Uplinks obtenidos v├¡a fallback de dispositivo para ${mxDevice.serial}`);
      } catch (err) {
  logger.warn(`Fall├│ fallback getDeviceUplink para ${mxDevice?.serial}: ${err.message}`);
      }
    }

    const uplinkAddressesBySerial = new Map();
    if (Array.isArray(uplinkAddressesRaw)) {
      uplinkAddressesRaw.forEach((entry) => {
        if (entry && entry.serial) {
          const serialKeyRaw = entry.serial.toString();
          const serialUpperKey = serialKeyRaw.toUpperCase();
          uplinkAddressesBySerial.set(serialKeyRaw, entry);
          if (!uplinkAddressesBySerial.has(serialUpperKey)) {
            uplinkAddressesBySerial.set(serialUpperKey, entry);
          }
        }
      });
    }

    if (uplinkAddressesBySerial.size && applianceUplinks.length) {
      applianceUplinks = applianceUplinks.map((uplink) => {
        const serialKey = uplink.serial || mxDevice?.serial;
        const entry = serialKey ? uplinkAddressesBySerial.get(serialKey) : null;
        if (!entry) return uplink;
        const resolved = pickUplinkAddressDetails(entry, uplink.interface);
        if (!resolved) {
          return { ...uplink, addressDetails: null };
        }
        const { details, key } = resolved;
        const merged = { ...uplink };
        if (!merged.ip && details.ip) merged.ip = details.ip;
        if (!merged.publicIp && (details.publicIp || details.publicIP)) merged.publicIp = details.publicIp || details.publicIP;
        if (!merged.gateway && details.gateway) merged.gateway = details.gateway;
        if (!merged.dns && (details.dns || details.primaryDns || details.secondaryDns)) {
          merged.dns = details.dns || details.primaryDns;
          merged.dnsSecondary = details.secondaryDns || null;
        }
        merged.addressDetails = { source: key, ...details };
        return merged;
      });
    }

    // Enriquecer uplinks con portNumber (mapeo puerto f├¡sico del appliance)
    if (applianceUplinks.length && switchPorts.length && mxDevice) {
      applianceUplinks = enrichApplianceUplinksWithPortMapping(applianceUplinks, {
        switchPorts,
        applianceSerial: mxDevice.serial,
        applianceModel: mxDevice.model,
      });
    }

    let applianceUplinkHistory = [];
    if (shouldFetchApplianceData && (Array.isArray(applianceUplinkHistoryRaw) || Array.isArray(applianceUplinkUsageRaw))) {
      applianceUplinkHistory = normalizeUplinkHistory(applianceUplinkHistoryRaw, applianceUplinkUsageRaw, { serialHint: mxDevice?.serial });
    }

    applianceUplinkHistory = ensureUplinkHistoryCoverage(applianceUplinkHistory, applianceUplinks, {
      timespanSeconds: uplinkTimespan,
      now: Date.now(),
      serialHint: mxDevice?.serial,
    });

    const applianceMetricsMeta = {
      uplinkTimespan,
      uplinkResolution,
    };

    const applianceDevicePayload = mxDevice ? {
      ...mxDevice,
      status: mxDevice.status || statusMap.get(mxDevice.serial) || 'unknown'
    } : null;

    const securityDetailsPayload = {
      intrusion: (applianceSecurity && typeof applianceSecurity === 'object') ? applianceSecurity : null,
      orgDefaults: (applianceSecurityOrg && typeof applianceSecurityOrg === 'object') ? applianceSecurityOrg : null,
      malware: (applianceSecurityMalware && typeof applianceSecurityMalware === 'object') ? applianceSecurityMalware : null
    };

    const securitySummary = (() => {
      const { intrusion, orgDefaults, malware } = securityDetailsPayload;
      if (!intrusion && !orgDefaults && !malware) return null;
      const toMode = (val) => (val && typeof val === 'object') ? (val.mode || val.policy || null) : null;
      const toRuleset = (val) => (val && typeof val === 'object') ? (val.idsRuleset || val.ruleset || null) : null;
      const effectiveMode = toMode(intrusion) || toMode(orgDefaults) || null;
      const effectiveRuleset = toRuleset(intrusion) || toRuleset(orgDefaults) || null;
      const usingOrgDefaults = intrusion?.protectedNetworks?.useDefault ?? null;
      return {
        effectiveMode,
        effectiveRuleset,
        intrusionMode: toMode(intrusion),
        intrusionRuleset: toRuleset(intrusion),
        orgDefaultMode: toMode(orgDefaults),
        orgDefaultRuleset: toRuleset(orgDefaults),
        usingOrgDefaults,
        malwareMode: toMode(malware),
        malwareEnabled: typeof malware?.enabled === 'boolean' ? malware.enabled : (toMode(malware) ? toMode(malware) !== 'disabled' : null)
      };
    })();

    const hasTopologyNodes = Array.isArray(topologyGraph?.nodes) && topologyGraph.nodes.length > 0;

    const topologyInsights = (() => {
      if (!hasTopologyNodes || !mxDevice) return null;
      const nodes = Array.isArray(topologyGraph.nodes) ? topologyGraph.nodes : [];
      const links = Array.isArray(topologyGraph.links) ? topologyGraph.links : [];
      if (!nodes.length || !links.length) return null;

      const keyMap = new Map();
      nodes.forEach((node) => {
        if (!node) return;
        const idUpper = (node.id || '').toString().toUpperCase();
        if (idUpper) keyMap.set(idUpper, node);
        const serialUpper = (node.serial || '').toString().toUpperCase();
        if (serialUpper) keyMap.set(serialUpper, node);
        const macLower = (node.mac || '').toString().toLowerCase();
        if (macLower) keyMap.set(macLower, node);
      });

      const mxSerialUpper = (mxDevice.serial || '').toUpperCase();
      const mxMacLower = (mxDevice.mac || '').toLowerCase();
      const mxNode = keyMap.get(mxSerialUpper) || keyMap.get(mxMacLower);
      if (!mxNode) return null;

      const collectNeighbor = (nodeId) => {
        if (!nodeId) return null;
        const candidate = keyMap.get(nodeId.toString().toUpperCase()) || keyMap.get(nodeId.toString().toLowerCase());
        return candidate || null;
      };

      const neighborMap = new Map();
      links.forEach((link) => {
        if (!link) return;
        const src = link.source;
        const dst = link.target;
        if (!src || !dst) return;
        const isFromMx = src.toString().toUpperCase() === mxSerialUpper || src.toString().toLowerCase() === mxMacLower || src === mxNode.id;
        const isToMx = dst.toString().toUpperCase() === mxSerialUpper || dst.toString().toLowerCase() === mxMacLower || dst === mxNode.id;
        if (isFromMx) {
          const neighbor = collectNeighbor(dst);
          if (neighbor) {
            const key = (neighbor.serial || neighbor.id || neighbor.label || '').toString().toUpperCase();
            if (!neighborMap.has(key)) neighborMap.set(key, neighbor);
          }
        } else if (isToMx) {
          const neighbor = collectNeighbor(src);
          if (neighbor) {
            const key = (neighbor.serial || neighbor.id || neighbor.label || '').toString().toUpperCase();
            if (!neighborMap.has(key)) neighborMap.set(key, neighbor);
          }
        }
      });

      const neighbors = Array.from(neighborMap.values());
      if (!neighbors.length) return {
        applianceNode: {
          id: mxNode.id,
          label: mxNode.label || mxDevice.name || mxDevice.serial,
          serial: mxNode.serial || mxDevice.serial,
        },
        neighborCount: 0,
        neighbors: [],
        primarySwitchNode: null,
      };

      const switchesBySerial = new Map(switches.map((sw) => [(sw.serial || '').toUpperCase(), sw]));
      const primarySwitchNode = neighbors.find((node) => {
        const serialUpper = (node.serial || node.id || '').toUpperCase();
        if (switchesBySerial.has(serialUpper)) return true;
        return /switch/.test((node.label || '').toLowerCase());
      }) || null;

      return {
        applianceNode: {
          id: mxNode.id,
          label: mxNode.label || mxDevice.name || mxDevice.serial,
          serial: mxNode.serial || mxDevice.serial,
        },
        neighborCount: neighbors.length,
        neighbors: neighbors.map((node) => ({
          id: node.id,
          label: node.label,
          serial: node.serial || null,
          type: node.type || null,
          status: node.status || null,
        })),
        primarySwitchNode: primarySwitchNode ? {
          id: primarySwitchNode.id,
          label: primarySwitchNode.label,
          serial: primarySwitchNode.serial || null,
          status: primarySwitchNode.status || null,
        } : null,
      };
    })();

    // Enriquecer puertos del appliance con conectividad al switch/AP despu├®s de construir la topolog├¡a
    if (appliancePorts.length && mxDevice && topologyGraph) {
      appliancePorts = enrichAppliancePortsWithSwitchConnectivity(appliancePorts, {
        applianceSerial: mxDevice.serial,
        applianceModel: mxDevice.model,
        topology: topologyGraph,
        switchesDetailed: switchesDetailed,
        accessPoints: accessPoints,
      });
      // Recalcular resumen despu├®s del enriquecimiento
      appliancePortSummary = summarizeAppliancePorts(appliancePorts);
    }

    const applianceStatusList = [];
    if (applianceDevicePayload) {
      applianceStatusList.push({
        device: applianceDevicePayload,
        uplinks: applianceUplinks,
        uplinkHistory: applianceUplinkHistory,
        metricsMeta: applianceMetricsMeta,
        ports: appliancePorts,
        portSummary: appliancePortSummary,
        performance: appliancePerformance,
        connectivity: applianceConnectivity,
        security: applianceSecurity,
        securityDetails: securityDetailsPayload,
        securitySummary,
        trafficShaping: applianceTraffic,
        bandwidth: applianceBandwidth
      });
    } else if (!shouldFetchApplianceData && teleworkerDevices.length) {
      teleworkerDevices.forEach((device, index) => {
        const serial = device?.serial || null;
        const serialUpper = serial ? serial.toUpperCase() : null;
        const status = statusMap.get(serial) || device.status || 'unknown';
        const keySuffix = serial || `idx${index}`;
        const baseKey = `teleworker:${keySuffix}`;

        const portStatusesRaw = optionalResults[`${baseKey}:portStatuses`]?.status === 'fulfilled'
          ? optionalResults[`${baseKey}:portStatuses`].value
          : [];
        const orgUplinksRaw = optionalResults[`${baseKey}:orgUplinks`]?.status === 'fulfilled'
          ? optionalResults[`${baseKey}:orgUplinks`].value
          : null;
        const deviceUplinkRaw = optionalResults[`${baseKey}:deviceUplink`]?.status === 'fulfilled'
          ? optionalResults[`${baseKey}:deviceUplink`].value
          : null;
        const uplinkHistoryRaw = optionalResults[`${baseKey}:uplinkHistory`]?.status === 'fulfilled'
          ? optionalResults[`${baseKey}:uplinkHistory`].value
          : null;
        const uplinkUsageRaw = optionalResults[`${baseKey}:uplinkUsage`]?.status === 'fulfilled'
          ? optionalResults[`${baseKey}:uplinkUsage`].value
          : null;

        let teleworkerUplinks = [];
        if (orgUplinksRaw) {
          teleworkerUplinks = normalizeApplianceUplinks(orgUplinksRaw, { serial });
        }
        if (!teleworkerUplinks.length && deviceUplinkRaw) {
          teleworkerUplinks = normalizeApplianceUplinks(deviceUplinkRaw, { serial });
        }

        if (teleworkerUplinks.length && uplinkAddressesBySerial.size && serialUpper) {
          const addressEntry = uplinkAddressesBySerial.get(serialUpper) || uplinkAddressesBySerial.get(serial) || uplinkAddressesBySerial.get(serialUpper.toLowerCase());
          if (addressEntry) {
            teleworkerUplinks = teleworkerUplinks.map((uplink) => {
              const resolved = pickUplinkAddressDetails(addressEntry, uplink.interface);
              if (!resolved) return uplink;
              const { details, key } = resolved;
              const merged = { ...uplink };
              if (!merged.ip && details.ip) merged.ip = details.ip;
              if (!merged.publicIp && (details.publicIp || details.publicIP)) merged.publicIp = details.publicIp || details.publicIP;
              if (!merged.gateway && details.gateway) merged.gateway = details.gateway;
              if (!merged.dns && (details.dns || details.primaryDns || details.secondaryDns)) {
                merged.dns = details.dns || details.primaryDns;
                merged.dnsSecondary = details.secondaryDns || null;
              }
              merged.addressDetails = { source: key, ...details };
              return merged;
            });
          }
        }

        teleworkerUplinks = teleworkerUplinks.map((uplink) => {
          if (!uplink) return uplink;
          const statusLabel = uplink.status || uplink.reachability || uplink.statusNormalized || 'unknown';
          const normalizedStatus = uplink.statusNormalized || normalizeStatus(statusLabel, { defaultStatus: statusLabel || 'unknown' });
          return {
            ...uplink,
            serial: uplink.serial || serial,
            statusNormalized: normalizedStatus,
          };
        }).filter(Boolean);

        if (serialUpper && teleworkerUplinks.length) {
          teleworkerUplinks = teleworkerUplinks.filter((uplink) => {
            const entrySerial = (uplink?.serial || serial || '').toString().toUpperCase();
            return entrySerial === serialUpper;
          });
        }

        if (!teleworkerUplinks.length) {
          const statusLabel = status || 'unknown';
          const normalizedStatus = normalizeStatus(statusLabel, { defaultStatus: statusLabel || 'unknown', forPort: true });
          teleworkerUplinks = [{
            serial,
            interface: 'WAN',
            status: statusLabel,
            statusNormalized: normalizedStatus,
            ip: device?.wanIp || device?.lanIp || null,
            publicIp: device?.publicIp || null,
          }];
        }

        let teleworkerHistory = [];
        const hasHistoryPayload = uplinkHistoryRaw && (Array.isArray(uplinkHistoryRaw) ? uplinkHistoryRaw.length > 0 : typeof uplinkHistoryRaw === 'object');
        const hasUsagePayload = uplinkUsageRaw && (Array.isArray(uplinkUsageRaw) ? uplinkUsageRaw.length > 0 : typeof uplinkUsageRaw === 'object');
        if (hasHistoryPayload || hasUsagePayload) {
          teleworkerHistory = normalizeUplinkHistory(uplinkHistoryRaw, uplinkUsageRaw, { serialHint: serial });
        }
        if (!Array.isArray(teleworkerHistory)) teleworkerHistory = [];
        if (serialUpper) {
          teleworkerHistory = teleworkerHistory.filter((series) => {
            if (!series) return false;
            const serieSerial = (series.serial || serial || '').toString().toUpperCase();
            return serieSerial === serialUpper;
          });
        }
        teleworkerHistory = ensureUplinkHistoryCoverage(teleworkerHistory, teleworkerUplinks, {
          timespanSeconds: uplinkTimespan,
          now: Date.now(),
          serialHint: serial,
        });

        let teleworkerPorts = [];
        const hasConfigs = Array.isArray(appliancePortConfigs) && appliancePortConfigs.length;
        const hasStatuses = Array.isArray(portStatusesRaw) && portStatusesRaw.length;
        if (hasConfigs || hasStatuses || teleworkerUplinks.length) {
          teleworkerPorts = mergeAppliancePorts(appliancePortConfigs, portStatusesRaw || [], teleworkerUplinks);
          
          // Enriquecer puertos teleworker con conectividad al switch/AP
          if (device && topologyGraph) {
            teleworkerPorts = enrichAppliancePortsWithSwitchConnectivity(teleworkerPorts, {
              applianceSerial: serial,
              applianceModel: device.model,
              topology: topologyGraph,
              switchesDetailed: switchesDetailed,
              accessPoints: accessPoints,
            });
          }
        }
        const teleworkerPortSummary = teleworkerPorts.length ? summarizeAppliancePorts(teleworkerPorts) : null;

        const notesList = [];
        if (device?.notes) notesList.push(device.notes);
        notesList.push('Dispositivo teleworker (Z-series/UTM) con m├®tricas en vivo');
        const combinedNotes = Array.from(new Set(notesList.filter(Boolean))).join(' | ');

        const devicePayload = {
          ...device,
          status,
          notes: combinedNotes,
          tags: Array.isArray(device?.tags) ? device.tags : [],
        };

        const metricsMeta = {
          ...applianceMetricsMeta,
          serial,
        };

        applianceStatusList.push({
          device: devicePayload,
          uplinks: teleworkerUplinks,
          uplinkHistory: teleworkerHistory,
          metricsMeta,
          ports: teleworkerPorts,
          portSummary: teleworkerPortSummary,
          performance: null,
          connectivity: null,
          security: null,
          securityDetails: null,
          securitySummary: null,
          trafficShaping: null,
          bandwidth: []
        });

  logger.info(`Teleworker ${serial || keySuffix} ┬À uplinks=${teleworkerUplinks.length} ┬À puertos=${teleworkerPorts.length} ┬À series=${teleworkerHistory.length}`);
      });
    }

    if (!applianceStatusList.length && applianceUplinks.length) {
      const sampleUplink = applianceUplinks[0];
      const inferredStatus = normalizeStatus(sampleUplink.statusNormalized || sampleUplink.status, { defaultStatus: 'unknown' });
      const syntheticSerial = sampleUplink.serial || mxDevice?.serial || `uplink-${networkId}`;
      applianceStatusList.push({
        device: {
          serial: syntheticSerial,
          mac: mxDevice?.mac,
          model: mxDevice?.model || (networkInfo?.productTypes?.join('/') || 'Meraki Appliance'),
          name: mxDevice?.name || coverageName || networkInfo?.name || syntheticSerial,
          networkId,
          status: inferredStatus,
          lastReportedAt: mxDevice?.lastReportedAt,
          tags: mxDevice?.tags || [],
          notes: 'Equipo sin inventario devuelto por /devices; se infiere a partir del estado de los uplinks.'
        },
        uplinks: applianceUplinks,
    uplinkHistory: applianceUplinkHistory,
    metricsMeta: applianceMetricsMeta,
        ports: appliancePorts,
    portSummary: appliancePortSummary,
        performance: appliancePerformance,
        connectivity: applianceConnectivity,
        security: applianceSecurity,
        securityDetails: securityDetailsPayload,
        securitySummary,
        trafficShaping: applianceTraffic,
        bandwidth: applianceBandwidth
      });
    }

    const hasApplianceSection = applianceStatusList.length > 0;
    const networkFlags = {
      flavor: networkFlavor,
      hasTopology: hasTopologyNodes,
      hideTopology: networkFlavor === 'GAP' || (!hasTopologyNodes && deviceProfile.switches === 0 && teleworkerDevices.length > 0),
      hasTeleworkers: teleworkerDevices.length > 0,
      hasSwitches: deviceProfile.switches > 0,
      hasAccessPoints: deviceProfile.accessPoints > 0,
      hasAppliance: Boolean(hasApplianceSection || mxDevice || utmDevices.length > 0 || teleworkerDevices.length > 0 || applianceUplinks.length > 0),
      usesUtm: utmDevices.length > 0 || (mxModelLower && mxModelLower.includes('utm')),
      usesGtw: (mxModelLower && mxModelLower.includes('gtw')) || networkFlavor === 'GTW',
      isTeleworkerOnly: teleworkerDevices.length > 0 && deviceProfile.switches === 0 && deviceProfile.accessPoints === 0,
      hideSwitches: deviceProfile.switches === 0,
      hideAccessPoints: (networkFlavor !== 'GAP' && networkFlavor !== 'GTW') && deviceProfile.accessPoints === 0,
      hideAppliance: !hasApplianceSection,
      teleworkerCount: teleworkerDevices.length,
      utmCount: utmDevices.length,
      mxSerial: mxDevice?.serial || applianceStatusList[0]?.device?.serial || null,
      defaultSection: (networkFlavor === 'GAP' || networkFlavor === 'GTW' || (hasApplianceSection && !deviceProfile.switches && !deviceProfile.accessPoints)) ? 'appliance_status' : null
    };

    const summary = {
      devices,
      topology: topologyGraph,
      topologySource,
  topologyInsights,
      deviceStatuses,
      switchPorts,
      switchesDetailed,
      switchesOverview,
      applianceStatus: applianceStatusList,
      loadTime: Date.now() - startTime,
      timestamp: new Date().toISOString(),
      networkMetadata,
      networkFlags,
      applianceMetricsMeta,
      accessPoints: summaryAccessPoints,
    };

    if (wirelessInsights) {
      summary.wirelessInsights = wirelessInsights;
    }

    if (Object.keys(lldpSnapshots).length) {
      summary.lldpSnapshots = lldpSnapshots;
    }

    if (Array.isArray(uplinkAddressesRaw) && uplinkAddressesRaw.length) {
      summary.applianceUplinkAddresses = uplinkAddressesRaw;
    }

    if (Array.isArray(organizationUplinksRaw) && organizationUplinksRaw.length) {
      summary.organizationUplinksStatuses = organizationUplinksRaw;
    }

    if (rawTopology && topologySource === 'meraki-link-layer') {
      summary.topologyRaw = rawTopology;
    }

    res.json(summary);
  } catch (error) {
    logger.error(`Error en /summary para ${networkId}:`, error.message, error.stack);
    res.status(500).json({ error: 'Error obteniendo el resumen del network', details: error.message });
  }

}


module.exports = { getNetworkSummary, handleNetworkSummary: getNetworkSummary };
