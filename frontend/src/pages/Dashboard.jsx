import React, { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react';
/* eslint-disable no-unused-vars */
// Algunas utilidades permanecen definidas para mantenimiento/depuración y pueden no usarse siempre.
import TopBar from '../components/TopBar';
import Sidebar from '../components/Sidebar';
import AppliancePortsMatrix from '../components/AppliancePortsMatrix';
import Tooltip from '../components/Tooltip';
import { SkeletonTable, SkeletonDeviceList, SkeletonTopology } from '../components/ui/SkeletonLoaders';
import { LoadingOverlay } from '../components/ui/LoadingOverlay';
import { normalizeReachability, getStatusColor as getStatusColorUtil, resolvePortColor as resolvePortColorUtil, looksLikeSerial, looksLikeMAC, normalizeMAC } from '../utils/networkUtils';
import { formatDuration, formatKbpsValue, formatQualityScore, formatCoverage, formatSpeedLabel as formatSpeedLabelUtil, formatWiredSpeed as formatWiredSpeedUtil } from '../utils/formatters';
import { isPageReload } from '../utils/constants';
import { fetchAPI } from '../utils/api';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';

// ========== COMPONENTES MODULARES DEL DASHBOARD ==========
// Iconos y helpers reutilizables
import { TopologyIcon, SwitchIcon, WifiIcon, ServerIcon } from '../components/dashboard/DashboardIcons';
import { SummaryChip } from '../components/dashboard/DashboardHelpers';
import { SortableHeader } from '../components/dashboard/SortableHeader';
// Estados del dashboard
import { LoadingState, EmptyState, NoDataState } from '../components/dashboard/DashboardStates';
// Componentes de switches (SwitchPortsGrid, SwitchCard se usan localmente con pequeñas diferencias)
// import { SwitchPortsGrid, SwitchCard, SwitchesMobileList } from '../components/dashboard/SwitchComponents';

// Lazy load componentes pesados para reducir bundle inicial
const SimpleGraph = lazy(() => import('../components/SimpleGraph'));
const ConnectivityGraph = lazy(() => import('../components/ConnectivityGraph'));
const ApplianceHistoricalCharts = lazy(() => import('../components/ApplianceHistoricalCharts'));

// Iconos importados desde DashboardIcons - eliminadas definiciones duplicadas

// Importar constantes desde utils/constants para evitar duplicación
import { 
  DEFAULT_SECTIONS, 
  DEFAULT_UPLINK_TIMESPAN, 
  DEFAULT_UPLINK_RESOLUTION 
} from '../utils/constants';

// Usar funciones de networkUtils
const getStatusColor = getStatusColorUtil;
const resolvePortColor = resolvePortColorUtil;

// Usar funciones de formatters
const formatSpeedLabel = formatSpeedLabelUtil;
const formatWiredSpeed = formatWiredSpeedUtil;

const summarizeUsage = (port) => {
  if (!port) return '-';
  if (port.usageKbps != null) return formatKbpsValue(port.usageKbps);
  const down = port.usageSplitKbps?.down;
  const up = port.usageSplitKbps?.up;
  if (down != null || up != null) {
    const downLabel = down != null ? formatKbpsValue(down) : '-';
    const upLabel = up != null ? formatKbpsValue(up) : '-';
    return `${downLabel} ↓ / ${upLabel} ↑`;
  }
  return '-';
};

const getPortAlias = (port) => {
  if (!port) return '';
  if (port.uplink?.interface) return port.uplink.interface.toUpperCase();
  if (port.name && !looksLikeSerial(port.name)) return port.name;
  if (port.role === 'wan') return `WAN ${port.number}`;
  return `Puerto ${port.number}`;
};

const getPortStatusLabel = (port) => {
  if (!port) return '-';
  if (port.enabled === false) return 'disabled';
  return normalizeReachability(port.statusNormalized || port.status);
};

const deriveConnectedPortsFromTopology = (applianceSerial, topology) => {
  try {
    if (!applianceSerial || !topology || !Array.isArray(topology.links)) return [];
    const serial = applianceSerial.toString();
    const ports = new Set();
    topology.links.forEach((link) => {
      const src = link.source ?? link.from ?? link.a ?? null;
      const dst = link.target ?? link.to ?? link.b ?? null;
      const other = src === serial ? dst : (dst === serial ? src : null);
      if (!other) return;
      const text = other?.toString() || '';
      // Buscar patrones tipo 'port-10' o 'port_10' o '-port-10' o 'port10' al final
      const m = text.match(/port[-_]?([0-9]{1,3})$/i) || text.match(/-p([0-9]{1,3})$/i) || text.match(/[:#]([0-9]{1,3})$/);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n)) ports.add(n);
      }
    });
    return Array.from(ports).sort((a, b) => a - b);
  } catch (e) {
    return [];
  }
};

// Nueva función: enriquecer puertos con dispositivos conectados
const enrichPortsWithConnections = (ports, applianceSerial, topology) => {
  try {
    if (!applianceSerial || !topology || !Array.isArray(topology.links) || !Array.isArray(topology.nodes)) return ports;

    const serial = applianceSerial.toString();
    const nodeMap = new Map(topology.nodes.map((n) => [n.id, n]));
    const portConnections = new Map();

    const inferTopologyDeviceType = (node = {}) => {
      const rawType = (node.type || '').toString().toLowerCase();
      if (rawType.includes('ap')) return 'ap';
      if (rawType.includes('switch') || rawType === 'ms') return 'switch';
      const model = (node.model || '').toString().toUpperCase();
      if (model.startsWith('MR')) return 'ap';
      if (model.startsWith('MS')) return 'switch';
      if (model.startsWith('MX') || model.startsWith('Z')) return 'appliance';
      return 'device';
    };

    topology.links.forEach((link) => {
      const src = link.source ?? link.from ?? link.a ?? null;
      const dst = link.target ?? link.to ?? link.b ?? null;

      // Verificar si alguno de los nodos involucra este appliance
      const srcIsTarget = src?.toString().startsWith(`${serial}-port-`);
      const dstIsTarget = dst?.toString().startsWith(`${serial}-port-`);

      if (srcIsTarget || dstIsTarget) {
        const portNodeId = srcIsTarget ? src : dst;
        const deviceNodeId = srcIsTarget ? dst : src;

        // Extraer número de puerto
        const portMatch = portNodeId.toString().match(/port-(\d+)$/);
        if (portMatch) {
          const portNum = Number(portMatch[1]);
          const deviceNode = nodeMap.get(deviceNodeId);
          if (deviceNode) {
            portConnections.set(portNum, {
              deviceName: deviceNode.label || deviceNode.name || deviceNode.id,
              deviceSerial: deviceNode.serial || deviceNode.id,
              deviceModel: deviceNode.model,
              deviceType: inferTopologyDeviceType(deviceNode),
            });
          }
        }
      }
    });

    // Enriquecer puertos con información de conexión
    return ports.map((port) => {
      const portNum = Number(port.number);
      if (Number.isFinite(portNum) && portConnections.has(portNum)) {
        const connectionInfo = portConnections.get(portNum);
        const resolvedDeviceType = connectionInfo.deviceType === 'ap' ? 'ap' : 'switch';
        const connection = {
          deviceName: connectionInfo.deviceName,
          deviceSerial: connectionInfo.deviceSerial,
          deviceType: resolvedDeviceType,
          deviceModel: connectionInfo.deviceModel,
          detectionMethod: 'topology',
        };

        const enrichedPort = {
          ...port,
          connectedDevice: connectionInfo.deviceName,
          connectedDeviceSerial: connectionInfo.deviceSerial,
          connection,
          statusNormalized: 'connected',
          status: port.status || 'active',
          hasCarrier: true,
        };

        if (!port.tooltipInfo) {
          enrichedPort.tooltipInfo = {
            type: resolvedDeviceType === 'ap' ? 'lan-ap-connection' : 'lan-switch-connection',
            deviceName: connectionInfo.deviceName,
            deviceSerial: connectionInfo.deviceSerial,
            devicePort: null,
            deviceType: resolvedDeviceType,
            appliancePort: portNum.toString(),
            detectionMethod: 'topology',
            status: 'connected',
          };
        }

        return enrichedPort;
      }
      return port;
    });
  } catch (e) {
    console.error('Error enriching ports:', e);
    return ports;
  }
};

// formatQualityScore y formatCoverage importados de formatters.js

const ConnectivityTimeline = ({ series }) => {
  const points = Array.isArray(series?.points) ? series.points : [];
  if (points.length < 2) return null;

  const parsed = points
    .map((point) => {
      const ts = new Date(point.ts || point.timestamp || point.time).getTime();
      if (Number.isNaN(ts)) return null;
      return {
        time: ts,
        status: normalizeReachability(point.statusNormalized || point.status || point.reachability),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.time - b.time);

  if (parsed.length < 2) return null;

  const totalDuration = parsed[parsed.length - 1].time - parsed[0].time;
  if (totalDuration <= 0) return null;

  const segments = [];
  for (let i = 0; i < parsed.length - 1; i += 1) {
    const current = parsed[i];
    const next = parsed[i + 1];
    const duration = next.time - current.time;
    if (duration <= 0) continue;
    segments.push({
      status: current.status,
      duration,
    });
  }

  if (!segments.length) return null;

  const statusColor = (status) => {
    if (status === 'connected') return '#22c55e';
    if (status === 'warning' || status === 'degraded' || status === 'alerting') return '#f59e0b';
    if (status === 'disabled') return '#94a3b8';
    return '#f97316';
  };

  return (
    <div style={{ display: 'flex', borderRadius: '3px', overflow: 'hidden', border: '1px solid #cbd5e1', height: 10, width: '100%' }}>
      {segments.map((segment, idx) => (
        <div
          key={`${segment.status}-${idx}`}
          style={{
            flex: segment.duration,
            background: statusColor(segment.status),
          }}
        />
      ))}
    </div>
  );
};

// Legacy component - conservado por compatibilidad
/*
const UsageSparkline = ({ series }) => {
  const points = Array.isArray(series?.points) ? series.points : [];
  const usagePoints = points
    .map((point) => ({
      value: point.totalKbps ?? point.usage ?? point.throughput ?? null,
    }))
    .filter((item) => typeof item.value === 'number' && !Number.isNaN(item.value));

  if (usagePoints.length < 2) return null;

  const maxValue = Math.max(...usagePoints.map((item) => item.value));
  if (!Number.isFinite(maxValue) || maxValue <= 0) return null;

  const width = 260;
  const height = 60;

  const path = usagePoints
    .map((item, index) => {
      const x = (index / (usagePoints.length - 1)) * width;
      const y = height - (item.value / maxValue) * height;
      const prefix = index === 0 ? 'M' : 'L';
      return `${prefix}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="#4f46e5" strokeWidth="2" />
    </svg>
  );
};
*/

const SignalQualitySparkline = ({ samples = [], threshold = 25 }) => {
  const points = Array.isArray(samples) ? samples.filter((sample) => sample && sample.signalQuality !== null && sample.signalQuality !== undefined) : [];
  if (points.length < 2) return null;

  const width = 260;
  const height = 70;
  const qualities = points.map((sample) => Number(sample.signalQuality));
  const maxValue = Math.max(...qualities, threshold + 5, 1);
  const minValue = Math.min(...qualities, threshold - 10);
  const range = Math.max(maxValue - minValue, 10);

  const toPathPoint = (sample, index) => {
    const x = (index / (points.length - 1 || 1)) * width;
    const normalized = (Number(sample.signalQuality) - minValue) / range;
    const y = height - normalized * height;
    const prefix = index === 0 ? 'M' : 'L';
    return `${prefix}${x.toFixed(2)},${y.toFixed(2)}`;
  };

  const linePath = points.map(toPathPoint).join(' ');
  const thresholdRatio = (threshold - minValue) / range;
  const thresholdY = height - thresholdRatio * height;
  const lastPoint = points[points.length - 1];
  const lastX = width;
  const lastNormalized = (Number(lastPoint.signalQuality) - minValue) / range;
  const lastY = height - lastNormalized * height;

  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block' }}>
      <defs>
        <linearGradient id="signalGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#22c55e" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0.15" />
        </linearGradient>
      </defs>
      <path d={`${linePath} L ${lastX} ${height} L 0 ${height} Z`} fill="url(#signalGradient)" opacity="0.35" />
      <path d={linePath} fill="none" stroke="#22c55e" strokeWidth="2" />
      <line x1="0" x2={width} y1={thresholdY} y2={thresholdY} stroke="#f97316" strokeDasharray="6 4" strokeWidth="1" />
      <circle cx={lastX} cy={lastY} r={3} fill="#0f172a" stroke="#fff" strokeWidth="1" />
    </svg>
  );
};

// Nuevo componente de barra de conectividad tipo Meraki Dashboard
const ConnectivityBar = React.memo(({ ap, device, networkId, orgId, connectivityDataProp }) => {
  const targetDevice = device || ap;
  const [connectivityData, setConnectivityData] = useState(connectivityDataProp || null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);
  
  // Protección completa contra datos mal formados
  const wireless = (targetDevice && targetDevice.wireless && typeof targetDevice.wireless === 'object') 
    ? targetDevice.wireless 
    : {};
  
  const historyArray = (wireless && Array.isArray(wireless.history)) ? wireless.history : [];
  const failureHistory = (wireless && Array.isArray(wireless.failureHistory)) ? wireless.failureHistory : [];
  const connectivitySource = failureHistory.length > 0 ? failureHistory : historyArray;
  const historyLength = connectivitySource.length;
  
  const statusNormalized = targetDevice ? (normalizeReachability(targetDevice.status) || 'offline') : 'unknown';
  const lastReportedAt = targetDevice?.lastReportedAt || null;
  const isAP = targetDevice?.model && targetDevice.model.toLowerCase().startsWith('mr');
  
  // Si recibimos datos como prop, usarlos
  useEffect(() => {
    if (connectivityDataProp) {
      setConnectivityData(connectivityDataProp);
    }
  }, [connectivityDataProp]);
  
  // Si es un AP y NO tenemos datos en prop, usar wireless.history directamente
  useEffect(() => {
    // Si ya tenemos datos del prop, no cargar
    if (connectivityDataProp) return;
    
    if (import.meta?.env?.DEV && isAP) {
      console.log(`[ConnectivityBar] AP ${targetDevice?.serial}:`, {
        hasHistory: historyArray.length > 0,
        historyLength: historyArray.length,
        hasFailureHistory: failureHistory.length > 0,
        failureHistoryLength: failureHistory.length,
        connectivitySourceLength: connectivitySource.length,
        status: statusNormalized
      });
    }
    
    // Para APs, usar los datos de wireless.history o failureHistory si existen
    if (isAP && historyLength > 0) {
      try {
        const convertedData = connectivitySource.map((sample) => {
          const sampleTs = sample.epochMs || (sample.ts ? Date.parse(sample.ts) : null);
          const quality = typeof sample.signalQuality === 'number' ? sample.signalQuality : (typeof sample.quality === 'number' ? sample.quality : null);
          const statusHint = normalizeReachability(sample.status || sample.state || sample.reachability || null);
          const failures = Number(sample.failures ?? sample.failureCount ?? 0);

          let latencyMs;
          let lossPercent;
          let severity = 'unknown';

          const applyQualityBuckets = (value) => {
            if (value === null || value === undefined) {
              latencyMs = null;
              lossPercent = null;
              severity = 'unknown';
              return;
            }
            if (value <= 10) {
              latencyMs = 480;
              lossPercent = 48;
              severity = 'critical';
            } else if (value <= 25) {
              latencyMs = 360;
              lossPercent = 30;
              severity = 'critical';
            } else if (value <= 45) {
              latencyMs = 220;
              lossPercent = 16;
              severity = 'warning';
            } else if (value <= 60) {
              latencyMs = 140;
              lossPercent = 9;
              severity = 'warning';
            } else if (value <= 75) {
              latencyMs = 90;
              lossPercent = 6;
              severity = 'notice';
            } else {
              latencyMs = 25;
              lossPercent = 1;
              severity = 'good';
            }
          };

          if (failures > 0 || statusHint === 'offline') {
            latencyMs = 500;
            lossPercent = 50;
            severity = 'critical';
          } else if (statusHint === 'warning' || statusHint === 'degraded') {
            latencyMs = 150;
            lossPercent = 10;
            severity = 'warning';
          } else {
            applyQualityBuckets(quality);
          }

          return {
            startTime: sampleTs ? Math.floor(sampleTs / 1000) : null,
            endTime: sampleTs ? Math.floor(sampleTs / 1000) + 300 : null,
            latencyMs,
            lossPercent,
            severity
          };
        });

        setConnectivityData(convertedData);
      } catch (error) {
        console.error('[ConnectivityBar] Error converting wireless.history:', error);
        // En caso de error, generar datos sintéticos como fallback
      }
      return;
    }
    
    // Si NO hay wireless.history, generar datos sintéticos basados en status
    if (isAP && historyLength === 0) {
      // Generar 144 buckets de 10 minutos (24 horas total)
      const numBuckets = 144;
      const bucketSize = 600; // 10 minutos en segundos
      const now = Math.floor(Date.now() / 1000);
      
      // Determinar calidad basada en status del AP
      let latencyMs = null;
      let lossPercent = null;
      
      if (statusNormalized === 'online' || statusNormalized === 'connected') {
        // Online = Verde (sin problemas)
        latencyMs = 20;
        lossPercent = 1;
      } else if (statusNormalized === 'offline' || statusNormalized === 'dormant' || statusNormalized === 'disconnected') {
        // Offline = Gris (sin datos)
        latencyMs = null;
        lossPercent = null;
      } else if (statusNormalized === 'alerting' || statusNormalized === 'warning') {
        // Warning = Amarillo/Naranja
        latencyMs = 80;
        lossPercent = 5;
      } else {
        // Desconocido = Gris
        latencyMs = null;
        lossPercent = null;
      }
      
      const syntheticData = Array(numBuckets).fill(0).map((_, i) => {
        const bucketStart = now - ((numBuckets - i) * bucketSize);
        return {
          startTime: bucketStart,
          endTime: bucketStart + bucketSize,
          latencyMs,
          lossPercent
        };
      });
      
      setConnectivityData(syntheticData);
      return;
    }
    
    // Para switches y otros dispositivos sin datos de conectividad, 
    // también generar datos sintéticos si no hay connectivityData
    if (!isAP && !connectivityDataProp) {
      const numBuckets = 144;
      const bucketSize = 600;
      const now = Math.floor(Date.now() / 1000);
      
      let latencyMs = null;
      let lossPercent = null;
      
      if (statusNormalized === 'online' || statusNormalized === 'connected') {
        latencyMs = 20;
        lossPercent = 1;
      } else if (statusNormalized === 'warning') {
        latencyMs = 80;
        lossPercent = 5;
      }
      
      const syntheticData = Array(numBuckets).fill(0).map((_, i) => {
        const bucketStart = now - ((numBuckets - i) * bucketSize);
        return {
          startTime: bucketStart,
          endTime: bucketStart + bucketSize,
          latencyMs,
          lossPercent
        };
      });
      
      setConnectivityData(syntheticData);
      return;
    }
  }, [isAP, historyLength, connectivityDataProp, statusNormalized, connectivitySource]);
  
  // Si targetDevice no existe, retornar barra gris DESPUÉS de todos los hooks
  if (!targetDevice) {
    return (
      <div style={{ display: 'flex', height: '10px', borderRadius: '3px', overflow: 'hidden', border: '1px solid #cbd5e1' }}>
        <div
          style={{
            width: '100%',
            background: '#d1d5db',
            transition: 'all 0.3s ease'
          }}
          title="Sin datos de dispositivo"
        />
      </div>
    );
  }
  
  const offlineStatuses = new Set(['offline', 'disconnected', 'dormant']);
  const isForceOffline = offlineStatuses.has(statusNormalized);

  // Si no hay datos, mostrar barra verde si está online (para switches), o gris si no
  if (!connectivityData || connectivityData.length === 0) {
    const barColor = statusNormalized === 'online' || statusNormalized === 'connected' ? '#22c55e' : '#d1d5db';
    const barLabel = statusNormalized === 'online' || statusNormalized === 'connected' ? 'Conectado (sin datos de tráfico)' : 'Sin datos';
    
    return (
      <div style={{ display: 'flex', height: '10px', borderRadius: '3px', overflow: 'hidden', border: '1px solid #cbd5e1' }}>
        <div
          style={{
            width: '100%',
            background: barColor,
            transition: 'all 0.3s ease'
          }}
          title={barLabel}
        />
      </div>
    );
  }

  if (isForceOffline) {
    const offlineLabel = 'Sin conectividad · dispositivo offline';
    return (
      <div style={{ display: 'flex', height: '10px', borderRadius: '3px', overflow: 'hidden', border: '1px solid #cbd5e1' }}>
        <div
          style={{
            width: '100%',
            background: '#cbd5e1',
            opacity: 0.9,
            transition: 'all 0.2s ease'
          }}
          title={offlineLabel}
        />
      </div>
    );
  }
  
  // Renderizar barras de conectividad
  const segments = connectivityData.map((point) => {
    const hasLatency = point.latencyMs !== null && point.latencyMs !== undefined;
    const hasLoss = point.lossPercent !== null && point.lossPercent !== undefined;
    const severity = point.severity;
    
    let color = '#d1d5db';
    let label = 'Sin datos';
    
    if (severity === 'critical') {
      color = '#ef4444';
      label = 'Sin conectividad';
    } else if (severity === 'warning') {
      color = '#f97316';
      label = 'Conectividad degradada';
    } else if (severity === 'notice') {
      color = '#fbbf24';
      label = 'Conectividad inestable';
    } else if (severity === 'good') {
      color = '#22c55e';
      label = 'Conectado';
    } else if (!hasLatency && !hasLoss) {
      color = '#d1d5db';
      label = 'Sin datos';
    } else {
      const loss = point.lossPercent || 0;
      const latency = point.latencyMs || 0;
      
      if (loss > 25 || latency > 350) {
        color = '#ef4444';
        label = 'Sin conectividad';
      } else if (loss > 8 || latency > 150) {
        color = '#f97316';
        label = 'Conectividad degradada';
      } else if (loss > 3 || latency > 80) {
        color = '#fbbf24';
        label = 'Conectividad inestable';
      } else {
        color = '#22c55e';
        label = 'Conectado';
      }
    }
    
    // Agregar información de tiempo al tooltip
    let tooltip = label;
    if (point.startTime && point.endTime) {
      const startDate = new Date(point.startTime * 1000);
      const endDate = new Date(point.endTime * 1000);
      const formatTime = (d) => d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
      tooltip = `${label}\n${formatTime(startDate)} - ${formatTime(endDate)}`;
    }
    
    return { color, label, tooltip };
  });
  
  const segmentWidth = connectivityData.length > 0 ? (100 / connectivityData.length) : 100;
  
  return (
    <div style={{ display: 'flex', height: '10px', borderRadius: '3px', overflow: 'hidden', border: '1px solid #cbd5e1' }}>
      {segments.map((segment, idx) => (
        <div
          key={idx}
          style={{
            flex: `0 0 ${segmentWidth}%`,
            background: segment.color,
            transition: 'all 0.2s ease',
            minWidth: '1px',
            cursor: 'help'
          }}
          title={segment.tooltip || segment.label}
        />
      ))}
    </div>
  );
});

const AccessPointRow = React.memo(({ ap, isDesktop, networkId, orgId, isLLDPLoaded }) => {
  const normalizedStatus = normalizeReachability(ap.status);
  const tooltipInfo = ap.tooltipInfo;
  
  // Construir texto del tooltip de status con razón si está en warning
  const getStatusTooltipContent = () => {
    const baseText = 
      normalizedStatus === 'connected' ? 'Conectado' :
      normalizedStatus === 'disconnected' ? 'Desconectado' :
      normalizedStatus === 'warning' ? 'Advertencia' :
      normalizedStatus === 'disabled' ? 'Deshabilitado' : 'Desconocido';
    
    // Si hay razón del warning, mostrar tooltip detallado
    if (normalizedStatus === 'warning' && tooltipInfo?.statusReason) {
      return (
        <div style={{ maxWidth: '280px' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px', color: '#f59e0b' }}>{baseText}</div>
          <div style={{ fontSize: '12px', color: '#64748b' }}>{tooltipInfo.statusReason}</div>
        </div>
      );
    }
    return baseText;
  };

  const statusIcon = (
    <span 
      style={{ 
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '22px',
        height: '22px',
        borderRadius: '50%',
        background: normalizedStatus === 'connected' ? '#d1fae5' : normalizedStatus === 'warning' ? '#fef3c7' : normalizedStatus === 'disconnected' ? '#fee2e2' : '#f1f5f9',
      }}
    >
      <span style={{ 
        width: '9px', 
        height: '9px', 
        borderRadius: '50%', 
        background: normalizedStatus === 'connected' ? '#22c55e' : normalizedStatus === 'warning' ? '#f59e0b' : normalizedStatus === 'disconnected' ? '#ef4444' : '#94a3b8'
      }} />
    </span>
  );

  const tooltipContent = (isDesktop && tooltipInfo) ? (
    <div>
      <div className="tooltip-title">{tooltipInfo.name}</div>
      {tooltipInfo.model && (
        <div className="tooltip-row"><span className="tooltip-label">Modelo</span><span className="tooltip-value">{tooltipInfo.model}</span></div>
      )}
      {tooltipInfo.serial && (
        <div className="tooltip-row"><span className="tooltip-label">Serial</span><span className="tooltip-value">{tooltipInfo.serial}</span></div>
      )}
      {tooltipInfo.firmware && (
        <div className="tooltip-row"><span className="tooltip-label">Firmware</span><span className="tooltip-value">{tooltipInfo.firmware}</span></div>
      )}
      {tooltipInfo.lanIp && (
        <div className="tooltip-row"><span className="tooltip-label">LAN IP</span><span className="tooltip-value">{tooltipInfo.lanIp}</span></div>
      )}
      {tooltipInfo.signalQuality != null && (
        <div className="tooltip-row"><span className="tooltip-label">Calidad señal</span><span className="tooltip-value">{tooltipInfo.signalQuality}%</span></div>
      )}
      {tooltipInfo.clients != null && (
        <div className="tooltip-row"><span className="tooltip-label">Clientes</span><span className="tooltip-value">{tooltipInfo.clients}</span></div>
      )}
      {tooltipInfo.microDrops > 0 && (
        <div className="tooltip-row"><span className="tooltip-label">Microcortes</span><span className="tooltip-badge error">{tooltipInfo.microDrops}</span></div>
      )}
      {isLLDPLoaded && tooltipInfo.connectedTo && tooltipInfo.connectedTo !== '-' && (
        <div className="tooltip-row"><span className="tooltip-label">Conectado a</span><span className="tooltip-value">{tooltipInfo.connectedTo}</span></div>
      )}
      {isLLDPLoaded && tooltipInfo.wiredSpeed && tooltipInfo.wiredSpeed !== '-' && (
        <div className="tooltip-row"><span className="tooltip-label">Velocidad Ethernet</span><span className="tooltip-value">{tooltipInfo.wiredSpeed}</span></div>
      )}
    </div>
  ) : null;

  return (
    <tr>
      <td style={{ textAlign: 'center', padding: '8px 4px' }}>
        {isDesktop ? (
          <Tooltip content={getStatusTooltipContent()} position="top">
            {statusIcon}
          </Tooltip>
        ) : statusIcon}
      </td>
      <td style={{ textAlign: 'left', padding: '8px 10px', overflow: 'visible' }}>
        {isDesktop && tooltipContent ? (
          <Tooltip content={tooltipContent} position="right">
            <div style={{ fontWeight: '700', color: '#2563eb', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
              {ap.name || ap.serial}
            </div>
          </Tooltip>
        ) : (
          <div style={{ fontWeight: '700', color: '#2563eb', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ap.name || ap.serial}
          </div>
        )}
      </td>
      <td style={{ textAlign: 'left', padding: '8px 10px' }}>
        <ConnectivityBar 
          ap={ap} 
          networkId={networkId}
          orgId={orgId}
        />
      </td>
      <td style={{ textAlign: 'left', padding: '8px 10px', fontFamily: 'monospace', fontSize: '13px', color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ap.serial}
      </td>
      <td style={{ textAlign: 'left', fontSize: '13px', color: '#1e293b', padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {isLLDPLoaded ? formatWiredSpeed(ap.wiredSpeed) : '-'}
      </td>
      <td style={{ textAlign: 'left', fontSize: '13px', color: '#2563eb', fontWeight: '500', padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {isLLDPLoaded ? (ap.connectedTo ? ap.connectedTo.replace(/^.*?\s-\s/, '') : '-') : '-'}
      </td>
      <td style={{ textAlign: 'left', fontFamily: 'monospace', fontSize: '12px', color: '#64748b', padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ap.mac || '-'}
      </td>
      <td style={{ textAlign: 'left', fontSize: '13px', color: '#1e293b', padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {ap.lanIp || '-'}
      </td>
    </tr>
  );
});
AccessPointRow.displayName = 'AccessPointRow';

const AccessPointCard = React.memo(({ ap, signalThreshold = 25, isLLDPLoaded = false }) => {
  const statusColor = getStatusColor(ap.status);
  const wireless = ap.wireless || {};
  const summary = wireless.signalSummary || wireless.deviceAggregate || {};
  const history = Array.isArray(wireless.history) ? wireless.history : [];
  const clients = Array.isArray(wireless.clients) ? wireless.clients : [];
  const microDrops = summary.microDrops ?? wireless.microDrops ?? 0;
  const microDuration = summary.microDurationSeconds ?? wireless.microDurationSeconds ?? 0;
  const worst = summary.worst ?? summary.device?.min ?? null;
  const average = summary.average ?? summary.deviceAverage ?? null;
  const latest = summary.latest ?? null;

  const connectivitySeries = history.length
    ? {
        points: history.map((sample) => ({
          ts: sample.ts || sample.timestamp,
          status: (sample.signalQuality ?? 0) <= signalThreshold ? 'disconnected' : 'connected',
        })),
      }
    : null;

  const statusNormalized = normalizeReachability(ap.status);

  return (
    <div className="modern-card">
      <div className="modern-card-header">
        <div>
          <h3 className="modern-card-title">{ap.name || ap.serial}</h3>
          <p className="modern-card-subtitle">
            {ap.model} · {ap.serial}
          </p>
          <p className="modern-card-subtitle" style={{ marginTop: '2px', fontSize: '11px' }}>
            LLDP: {isLLDPLoaded ? (ap.connectedTo || '-') : '-'} · {isLLDPLoaded ? formatWiredSpeed(ap.wiredSpeed) : '-'}
          </p>
        </div>
        <span 
          className={`status-badge ${statusNormalized}`}
          style={{ 
            background: statusNormalized === 'connected' ? '#d1fae5' : statusNormalized === 'warning' ? '#fef9c3' : '#fee2e2',
            color: statusColor 
          }}
        >
          <span style={{ 
            width: '8px', 
            height: '8px', 
            borderRadius: '50%', 
            background: statusColor 
          }} />
          {ap.status || 'unknown'}
        </span>
      </div>

      {/* Calidad de señal metrics */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', 
        gap: '10px', 
        marginBottom: '16px'
      }}>
        <div style={{ 
          padding: '10px 12px', 
          borderRadius: '8px', 
          background: '#f0fdf4', 
          border: '1px solid #bbf7d0' 
        }}>
          <div style={{ fontSize: '10px', color: '#047857', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Promedio
          </div>
          <div style={{ fontSize: '18px', fontWeight: '700', color: '#047857', marginTop: '2px' }}>
            {formatQualityScore(average)}
          </div>
        </div>
        <div style={{ 
          padding: '10px 12px', 
          borderRadius: '8px', 
          background: '#eff6ff', 
          border: '1px solid #bfdbfe' 
        }}>
          <div style={{ fontSize: '10px', color: '#1d4ed8', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Actual
          </div>
          <div style={{ fontSize: '18px', fontWeight: '700', color: '#1d4ed8', marginTop: '2px' }}>
            {formatQualityScore(latest)}
          </div>
        </div>
        <div style={{ 
          padding: '10px 12px', 
          borderRadius: '8px', 
          background: '#fef3c7', 
          border: '1px solid #fde68a' 
        }}>
          <div style={{ fontSize: '10px', color: '#a16207', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Peor
          </div>
          <div style={{ fontSize: '18px', fontWeight: '700', color: '#a16207', marginTop: '2px' }}>
            {formatQualityScore(worst)}
          </div>
        </div>
      </div>

      {microDrops > 0 && (
        <div style={{ 
          padding: '12px', 
          background: '#fef2f2', 
          border: '1px solid #fecaca', 
          borderRadius: '10px', 
          marginBottom: '14px'
        }}>
          <div style={{ fontSize: '12px', fontWeight: '600', color: '#b91c1c' }}>
            Microcortes detectados
          </div>
          <div style={{ fontSize: '14px', color: '#991b1b', marginTop: '4px' }}>
            {microDrops} eventos · {formatDuration(microDuration)}
          </div>
        </div>
      )}

      {history.length > 1 ? (
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Evolución de señal (24h)
          </div>
          <SignalQualitySparkline samples={history} threshold={signalThreshold} />
        </div>
      ) : (
        <div style={{ fontSize: '12px', color: '#94a3b8', fontStyle: 'italic', marginBottom: '14px' }}>
          No hay historial de señal disponible
        </div>
      )}

      {connectivitySeries && (
        <div style={{ marginBottom: '14px' }}>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '600', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Conectividad (estable · inestable)
          </div>
          <ConnectivityTimeline series={connectivitySeries} />
        </div>
      )}

      {clients.length > 0 && (
        <div style={{ 
          borderTop: '2px solid #cbd5e1', 
          paddingTop: '14px',
          marginTop: '14px'
        }}>
          <div style={{ fontSize: '12px', fontWeight: '600', color: '#475569', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Clientes con peor señal
          </div>
          <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '12px', color: '#64748b', display: 'grid', gap: '6px', lineHeight: '1.5' }}>
            {clients.slice(0, 4).map((client) => (
              <li key={client.id || client.mac}>
                <strong style={{ color: '#475569' }}>{client.label || client.mac || client.id}</strong> · {formatQualityScore(client.signalQuality)} {client.ssid ? `· ${client.ssid}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
});

// SummaryChip importado desde DashboardHelpers - eliminada definición duplicada

const SwitchPortsGrid = ({ ports = [] }) => {
  if (!ports.length) return <div style={{ fontSize: 13, color: '#64748b' }}>Sin información de puertos disponible.</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(78px, 1fr))', gap: 8, overflow: 'visible' }}>
      {ports.map((port) => {
        const color = resolvePortColor(port);
        const label = port.status || port.statusNormalized || 'unknown';
        const isConnected = normalizeReachability(port.statusNormalized || port.status) === 'connected';
        const bgColor = isConnected ? '#a7f3d0' : '#fff'; // Verde más vibrante (era #d1fae5)
        
        // Construir tooltip para el puerto
        const portTooltip = (
          <div>
            <div className="tooltip-title">Puerto {port.portId}</div>
            <div className="tooltip-row">
              <span className="tooltip-label">Estado</span>
              <span className="tooltip-value">{port.status || 'Desconocido'}</span>
            </div>
            {port.name && (
              <div className="tooltip-row">
                <span className="tooltip-label">Nombre</span>
                <span className="tooltip-value">{port.name}</span>
              </div>
            )}
            {port.vlan && (
              <div className="tooltip-row">
                <span className="tooltip-label">VLAN</span>
                <span className="tooltip-value">{port.vlan}</span>
              </div>
            )}
            {port.type && (
              <div className="tooltip-row">
                <span className="tooltip-label">Tipo</span>
                <span className="tooltip-value">{port.type}</span>
              </div>
            )}
            {port.speed && (
              <div className="tooltip-row">
                <span className="tooltip-label">Velocidad</span>
                <span className="tooltip-value">{port.speed}</span>
              </div>
            )}
            {port.duplex && (
              <div className="tooltip-row">
                <span className="tooltip-label">Duplex</span>
                <span className="tooltip-value">{port.duplex}</span>
              </div>
            )}
            {port.poeEnabled && (
              <div className="tooltip-row">
                <span className="tooltip-label">PoE</span>
                <span className="tooltip-value">Habilitado</span>
              </div>
            )}
            {port.linkNegotiation && (
              <div className="tooltip-row">
                <span className="tooltip-label">Negociación</span>
                <span className="tooltip-value">{port.linkNegotiation}</span>
              </div>
            )}
            {port.isUplink && (
              <div className="tooltip-row">
                <span className="tooltip-label">Función</span>
                <span className="tooltip-value">Puerto Uplink</span>
              </div>
            )}
            {port.enabled !== undefined && (
              <div className="tooltip-row">
                <span className="tooltip-label">Habilitado</span>
                <span className="tooltip-value">{port.enabled ? 'Sí' : 'No'}</span>
              </div>
            )}
          </div>
        );
        
        return (
          <Tooltip key={port.portId} content={portTooltip} position="auto">
            <div style={{ border: '1px solid #cbd5e1', borderRadius: 8, padding: '6px 8px', background: bgColor, position: 'relative', cursor: 'pointer' }}>
              <div style={{ fontWeight: 600, color: color }}>{port.portId}</div>
              <div style={{ fontSize: 12, color: '#475569' }}>{label}</div>
              {port.isUplink && (
                <span style={{ position: 'absolute', top: 6, right: 8, fontSize: 10, background: '#1d4ed8', color: '#fff', borderRadius: 999, padding: '1px 6px' }}>Uplink</span>
              )}
              {port.poeEnabled && (
                <span style={{ position: 'absolute', bottom: 6, right: 8, fontSize: 10, background: '#047857', color: '#fff', borderRadius: 999, padding: '1px 6px' }}>PoE</span>
              )}
              {port.vlan && (
                <div style={{ fontSize: 11, color: '#64748b' }}>VLAN {port.vlan}</div>
              )}
            </div>
          </Tooltip>
        );
      })}
    </div>
  );
};

const SwitchCard = ({ sw }) => {
  const statusColor = getStatusColor(sw.status);
  const stats = sw.stats || {};
  const portsToShow = Array.isArray(sw.ports) ? sw.ports : [];
  
  const statusNormalized = normalizeReachability(sw.status);

  // Información de uplink (conexión al appliance/upstream)
  const uplinkInfo = sw.connectedTo || null;

  // Construir contenido del tooltip para el switch
  const switchTooltip = sw.tooltipInfo ? (
    <div>
      <div className="tooltip-title">{sw.tooltipInfo.name}</div>
      <div className="tooltip-row">
        <span className="tooltip-label">Modelo</span>
        <span className="tooltip-value">{sw.tooltipInfo.model}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">Serial</span>
        <span className="tooltip-value">{sw.tooltipInfo.serial}</span>
      </div>
      {sw.tooltipInfo.mac && (
        <div className="tooltip-row">
          <span className="tooltip-label">MAC</span>
          <span className="tooltip-value">{sw.tooltipInfo.mac}</span>
        </div>
      )}
      <div className="tooltip-row">
        <span className="tooltip-label">Firmware</span>
        <span className="tooltip-value">{sw.tooltipInfo.firmware || 'N/A'}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">LAN IP</span>
        <span className="tooltip-value">{sw.tooltipInfo.lanIp || 'N/A'}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">Puertos activos</span>
        <span className="tooltip-value">{sw.tooltipInfo.connectedPorts}/{sw.tooltipInfo.totalPorts}</span>
      </div>
      {sw.tooltipInfo.poePorts > 0 && (
        <div className="tooltip-row">
          <span className="tooltip-label">PoE</span>
          <span className="tooltip-value">{sw.tooltipInfo.poeActivePorts}/{sw.tooltipInfo.poePorts} activos</span>
        </div>
      )}
      {sw.tooltipInfo.connectedTo && sw.tooltipInfo.connectedTo !== '-' && (
        <>
          <div className="tooltip-row">
            <span className="tooltip-label">Conectado a</span>
            <span className="tooltip-value">{sw.tooltipInfo.connectedTo}</span>
          </div>
          <div className="tooltip-row">
            <span className="tooltip-label">Detección</span>
            <span className="tooltip-value">{sw.tooltipInfo.detectionMethod}</span>
          </div>
        </>
      )}
    </div>
  ) : null;

  // Tooltip para el badge de status con razón del warning
  const getStatusTooltipContent = () => {
    const baseText = 
      statusNormalized === 'connected' ? 'Conectado' :
      statusNormalized === 'disconnected' ? 'Desconectado' :
      statusNormalized === 'warning' ? 'Advertencia' : 'Desconocido';
    
    if (statusNormalized === 'warning' && sw.statusReason) {
      return (
        <div style={{ maxWidth: '280px' }}>
          <div style={{ fontWeight: 600, marginBottom: '4px', color: '#f59e0b' }}>{baseText}</div>
          <div style={{ fontSize: '12px', color: '#64748b' }}>{sw.statusReason}</div>
        </div>
      );
    }
    return baseText;
  };

  return (
    <div className="modern-card">
      <div className="modern-card-header">
        <div>
          <Tooltip content={switchTooltip || "Switch sin tooltipInfo"} position="auto">
            <h3 className="modern-card-title" style={{ cursor: 'pointer' }}>{sw.name || sw.serial}</h3>
          </Tooltip>
          <p className="modern-card-subtitle">
            {sw.model} · {sw.serial}
          </p>
          {sw.lanIp && (
            <p className="modern-card-subtitle" style={{ marginTop: '2px' }}>
              IP: {sw.lanIp}
            </p>
          )}
          {uplinkInfo && uplinkInfo !== '-' && (
            <div 
              style={{ 
                marginTop: '6px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '4px 10px',
                background: '#eff6ff',
                border: '1px solid #bfdbfe',
                borderRadius: '6px',
                fontSize: '12px',
                color: '#1e40af',
                fontWeight: '600'
              }}
              title={`Switch conectado a: ${uplinkInfo}`}
            >
              <span style={{ fontSize: '14px' }}>Uplink</span>
              <span>&#8594; {uplinkInfo}</span>
            </div>
          )}
        </div>
      <Tooltip content={getStatusTooltipContent()} position="left">
        <span 
          className={`status-badge ${statusNormalized}`}
          style={{ 
            background: statusNormalized === 'connected' ? '#d1fae5' : statusNormalized === 'warning' ? '#fef9c3' : '#fee2e2',
            color: statusColor,
            cursor: statusNormalized === 'warning' ? 'help' : 'default'
          }}
        >
          <span style={{ 
            width: '8px', 
            height: '8px', 
            borderRadius: '50%', 
            background: statusColor 
          }} />
          {sw.status}
        </span>
      </Tooltip>
    </div>      {/* Stats grid */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', 
        gap: '12px', 
        marginBottom: '18px',
        padding: '14px',
        background: '#f1f5f9',
        borderRadius: '10px'
      }}>
        <div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Total
          </div>
          <div style={{ fontSize: '20px', fontWeight: '700', color: '#1e293b', marginTop: '2px' }}>
            {stats.totalPorts || 0}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Activos
          </div>
          <div style={{ fontSize: '20px', fontWeight: '700', color: '#22c55e', marginTop: '2px' }}>
            {stats.connectedPorts || 0}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Inactivos
          </div>
          <div style={{ fontSize: '20px', fontWeight: '700', color: '#f59e0b', marginTop: '2px' }}>
            {stats.inactivePorts || 0}
          </div>
        </div>
        <div>
          <div style={{ fontSize: '11px', color: '#64748b', fontWeight: '500', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            PoE
          </div>
          <div style={{ fontSize: '20px', fontWeight: '700', color: '#3b82f6', marginTop: '2px' }}>
            {stats.poeActivePorts || 0}
          </div>
        </div>
      </div>

      {/* Ports grid */}
      <div>
        <div style={{ 
          fontSize: '12px', 
          fontWeight: '600', 
          color: '#475569', 
          marginBottom: '10px',
          textTransform: 'uppercase',
          letterSpacing: '0.5px'
        }}>
          Puertos ({portsToShow.length})
        </div>
        <SwitchPortsGrid ports={portsToShow} />
      </div>
    </div>
  );
};


export default function Dashboard({ onLogout }) {
  // Detectar si es un page reload - usar función importada que usa API moderna
  const wasPageReload = isPageReload();
  
  // Solo cargar último predio si es un reload, no en login inicial
  const initialNetwork = wasPageReload 
    ? (() => {
        try {
          const stored = localStorage.getItem('lastSelectedNetwork');
          return stored ? JSON.parse(stored) : null;
        } catch {
          return null;
        }
      })()
    : null;

  const [selectedNetwork, setSelectedNetwork] = useState(initialNetwork);
  const [windowWidth, setWindowWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const [section, setSection] = useState('topology');
  const [summaryData, setSummaryData] = useState(null); // Estado único para todos los datos
  const [loadedSections, setLoadedSections] = useState(new Set()); // Track de secciones cargadas
  const [sectionLoading, setSectionLoading] = useState(null); // Sección actual cargándose
  const [loading, setLoading] = useState(false);
  const [uplinkRange, setUplinkRange] = useState(DEFAULT_UPLINK_TIMESPAN);
  const [error, setError] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
  const [switchesTab, setSwitchesTab] = useState('list'); // 'list' o 'ports'
  const [enrichedAPs, setEnrichedAPs] = useState(null); // Datos completos de APs con LLDP/CDP
  const [apDataSource, setApDataSource] = useState(null); // 'summary' | 'lldp'
  const [loadingLLDP, setLoadingLLDP] = useState(false); // Estado de carga de datos LLDP
  const [apConnectivityData, setApConnectivityData] = useState({}); // Datos de conectividad por serial
  const hasAppliedPreferredRef = useRef(false);
  const hasMarkedApsSectionRef = useRef(false); // Track if we already marked APs section as loaded
  const hasAutoLoadedRef = useRef(false); // Track auto-load on page reload
  const hasFetchedEnrichedApsRef = useRef(false);

  // Track window width to enable mobile-specific rendering without affecting desktop
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('resize', onResize);
      return () => window.removeEventListener('resize', onResize);
    }
    return undefined;
  }, []);

  // Guardar último predio seleccionado para reload
  useEffect(() => {
    if (selectedNetwork) {
      try {
        localStorage.setItem('lastSelectedNetwork', JSON.stringify(selectedNetwork));
      } catch (err) {
        console.warn('No se pudo guardar lastSelectedNetwork:', err);
      }
    }
  }, [selectedNetwork]);

  const isMobile = windowWidth <= 900;


  // Counts used in mobile section tiles (fall back to 0)
  const mobileCounts = {
    topology: summaryData?.topology?.nodes?.length || 0,
    switches: Array.isArray(summaryData?.devices) ? summaryData.devices.filter(d => (d.model || '').toLowerCase().startsWith('ms')).length : 0,
    access_points: Array.isArray(summaryData?.devices) ? summaryData.devices.filter(d => (d.model || '').toLowerCase().startsWith('mr')).length : 0,
    appliance_status: Array.isArray(summaryData?.applianceStatus) ? summaryData.applianceStatus.length : 0,
  };

  const availableSections = useMemo(() => {
    if (!summaryData) return DEFAULT_SECTIONS;

    const flags = summaryData.networkFlags || {};
    const deviceProfile = summaryData.networkMetadata?.deviceProfile || {};
    const deviceList = Array.isArray(summaryData.devices) ? summaryData.devices : [];
    const topologyNodes = Array.isArray(summaryData.topology?.nodes) ? summaryData.topology.nodes.length : 0;

    const calcHasSwitches = (deviceProfile.switches ?? 0) > 0 || deviceList.some(d => (d.model || '').toLowerCase().startsWith('ms'));
    const calcHasAps = (deviceProfile.accessPoints ?? 0) > 0 || deviceList.some(d => (d.model || '').toLowerCase().startsWith('mr'));
    const calcHasAppliance = (Array.isArray(summaryData.applianceStatus) && summaryData.applianceStatus.length > 0) || deviceList.some(d => /(mx|utm|z)/i.test(d.model || ''));

    const showTopology = !((flags.hideTopology ?? false) || topologyNodes === 0);
    const showSwitches = (flags.hideSwitches === true) ? false : (flags.hasSwitches ?? calcHasSwitches);
    const keepApTab = flags.flavor === 'GAP' || flags.flavor === 'GTW' || flags.hasTeleworkers;
    const showAccessPoints = (flags.hideAccessPoints === true) ? false : ((flags.hasAccessPoints ?? calcHasAps) || keepApTab);
    const showAppliance = (flags.hideAppliance === true) ? false : ((flags.hasAppliance ?? calcHasAppliance) || keepApTab || flags.usesUtm || flags.usesGtw);

    const filtered = DEFAULT_SECTIONS.filter((item) => {
      if (item.k === 'topology') return showTopology;
      if (item.k === 'switches') return showSwitches;
      if (item.k === 'access_points') return showAccessPoints;
      if (item.k === 'appliance_status') return showAppliance;
      return true;
    });

    if (filtered.length) {
      const preferred = summaryData?.networkFlags?.defaultSection;
      if (preferred) {
        filtered.sort((a, b) => {
          if (a.k === preferred && b.k !== preferred) return -1;
          if (b.k === preferred && a.k !== preferred) return 1;
          return 0;
        });
      }
      return filtered;
    }
    return [{ k: 'appliance_status', t: 'Appliance Status' }];
  }, [summaryData]);

  const preferredSection = summaryData?.networkFlags?.defaultSection;

  // Datos derivados del summary para reutilizar en secciones
  const devices = summaryData?.devices ?? [];
  const topology = summaryData?.topology ?? null;
  const applianceStatus = summaryData?.applianceStatus ?? [];
  const switchPorts = summaryData?.switchPorts ?? [];
  const deviceStatuses = summaryData?.deviceStatuses ?? [];
  const switchesDetailed = summaryData?.switchesDetailed ?? [];
  const switchesOverview = summaryData?.switchesOverview ?? null;
  const wirelessInsights = summaryData?.wirelessInsights ?? null;

  const statusMap = useMemo(() => {
    const entries = [];
    if (Array.isArray(deviceStatuses)) {
      deviceStatuses.forEach((deviceStatus) => {
        const serial = (deviceStatus?.serial || '').toString();
        if (!serial) return;
        const raw = deviceStatus.status || deviceStatus.reachability || deviceStatus.connectionStatus;
        if (!raw) return;
        entries.push([serial, raw]);
        entries.push([serial.toUpperCase(), raw]);
      });
    }
    return new Map(entries);
  }, [deviceStatuses]);

  const topologyDevices = useMemo(() => {
    if (!Array.isArray(devices)) return [];
    return devices.map((device) => {
      const serial = (device?.serial || '').toString();
      const override = serial ? (statusMap.get(serial) || statusMap.get(serial.toUpperCase())) : null;
      const resolvedStatus = override || device?.status || device?.reachability || device?.connectionStatus || null;
      const normalizedStatus = normalizeReachability(resolvedStatus || device?.statusNormalized, 'unknown');
      return {
        ...device,
        status: resolvedStatus,
        statusNormalized: normalizedStatus,
      };
    });
  }, [devices, statusMap]);

  const summaryAccessPointMap = useMemo(() => {
    if (!Array.isArray(summaryData?.accessPoints)) return new Map();
    const entries = [];
    summaryData.accessPoints.forEach((ap) => {
      const serial = (ap?.serial || '').toString();
      if (!serial) return;
      entries.push([serial, ap]);
      entries.push([serial.toUpperCase(), ap]);
    });
    return new Map(entries);
  }, [summaryData?.accessPoints]);

  // Preparar accessPoints FUERA del renderSection para evitar hooks condicionales
  const wirelessDeviceSummaries = useMemo(() => {
    return Array.isArray(wirelessInsights?.devices) ? wirelessInsights.devices : [];
  }, [wirelessInsights]);

  const resolveWirelessSummary = useCallback((serial) => {
    if (!serial) return null;
    if (wirelessDeviceSummaries.length === 0) return null;
    const normalized = serial.toString().toUpperCase();
    const compact = normalized.replace(/-/g, '');
    return wirelessDeviceSummaries.find((item) => {
      const entrySerial = (item.serial || item.deviceSerial || '').toString().toUpperCase();
      if (!entrySerial) return false;
      return entrySerial === normalized || entrySerial === compact;
    }) || null;
  }, [wirelessDeviceSummaries]);

  const baseAccessPoints = useMemo(() => {
    if (Array.isArray(summaryData?.accessPoints) && summaryData.accessPoints.length > 0) {
      return summaryData.accessPoints.map((ap) => ({
        ...ap,
        status: statusMap.get(ap.serial) || ap.status,
      }));
    }

    const mrDevices = devices.filter((d) => d.model?.toLowerCase().startsWith('mr'));
    return mrDevices.map((ap) => {
      if (!ap || !ap.serial) {
        console.warn('AP sin serial detectado en fallback:', ap);
        return null;
      }

      const fallbackWireless = resolveWirelessSummary(ap.serial);
      const baseWireless = ap.wireless || fallbackWireless || null;

      let wirelessData = null;
      if (baseWireless && Array.isArray(baseWireless.history) && baseWireless.history.length > 0) {
        wirelessData = baseWireless;
      } else if (fallbackWireless) {
        wirelessData = {
          signalSummary: fallbackWireless.signalSummary || fallbackWireless,
          history: fallbackWireless.history || [],
          microDrops: fallbackWireless.microDrops || 0,
          microDurationSeconds: fallbackWireless.microDurationSeconds || 0
        };
      } else {
        wirelessData = {
          signalSummary: { signalQuality: null, clients: null, microDrops: 0 },
          history: [],
          microDrops: 0,
          microDurationSeconds: 0
        };
      }

      const tooltipInfo = {
        type: 'access-point',
        name: ap.name || ap.serial || '-',
        model: ap.model || '-',
        serial: ap.serial || '-',
        mac: ap.mac || '-',
        firmware: ap.firmware || '-',
        lanIp: ap.lanIp || '-',
        status: ap.status || 'unknown',
        signalQuality: wirelessData?.signalSummary?.signalQuality ?? null,
        clients: wirelessData?.signalSummary?.clients ?? null,
        microDrops: wirelessData?.signalSummary?.microDrops ?? 0,
        microDurationSeconds: wirelessData?.signalSummary?.microDurationSeconds ?? 0,
        connectedTo: ap.connectedTo || '-',
        wiredPort: ap.connectedPort || '-',
        wiredSpeed: ap.wiredSpeed || '-',
        power: ap.power ?? null
      };

      return {
        ...ap,
        status: statusMap.get(ap.serial) || ap.status,
        wireless: wirelessData,
        connectedTo: ap.connectedTo || '-',
        connectedPort: ap.connectedPort || '-',
        wiredSpeed: ap.wiredSpeed || '-',
        tooltipInfo
      };
    }).filter(Boolean);
  }, [summaryData?.accessPoints, devices, statusMap, resolveWirelessSummary]);

  const enrichedApMap = useMemo(() => {
    if (!Array.isArray(enrichedAPs) || enrichedAPs.length === 0) return null;
    const map = new Map();
    enrichedAPs.forEach((ap) => {
      if (!ap?.serial) return;
      const serial = ap.serial.toString();
      map.set(serial, ap);
      map.set(serial.toUpperCase(), ap);
      map.set(serial.replace(/-/g, ''), ap);
    });
    return map;
  }, [enrichedAPs]);

  const accessPoints = useMemo(() => {
    const source = baseAccessPoints;
    if (!Array.isArray(source) || source.length === 0) {
      return [];
    }

    if (!enrichedApMap) {
      if (import.meta?.env?.DEV && source.length > 0) {
        console.log('[Dashboard] accessPoints (no enrichment):', {
          sample: {
            serial: source[0].serial,
            wiredSpeed: source[0].wiredSpeed,
            hasWireless: !!source[0].wireless,
            hasHistory: Array.isArray(source[0].wireless?.history),
            historyLength: source[0].wireless?.history?.length || 0
          }
        });
      }
      return source;
    }

    const merged = source.map((ap) => {
      const serial = (ap.serial || '').toString();
      const compact = serial.replace(/-/g, '');
      const enriched = enrichedApMap.get(serial) || enrichedApMap.get(serial.toUpperCase()) || enrichedApMap.get(compact) || null;

      if (!enriched) {
        return ap;
      }

      const mergedTooltip = {
        ...ap.tooltipInfo,
        ...enriched.tooltipInfo,
        wiredSpeed: enriched.tooltipInfo?.wiredSpeed || ap.tooltipInfo?.wiredSpeed || '-',
        connectedTo: enriched.tooltipInfo?.connectedTo || ap.tooltipInfo?.connectedTo || '-',
        wiredPort: enriched.tooltipInfo?.wiredPort || ap.tooltipInfo?.wiredPort || '-'
      };

      const wiredSpeed = enriched.wiredSpeed || ap.wiredSpeed || mergedTooltip.wiredSpeed || '-';
      const connectedTo = enriched.connectedTo || ap.connectedTo || mergedTooltip.connectedTo || '-';
      const connectedPort = enriched.connectedPort || ap.connectedPort || mergedTooltip.wiredPort || '-';

      return {
        ...ap,
        ...enriched,
        status: statusMap.get(enriched.serial) || statusMap.get(ap.serial) || enriched.status || ap.status,
        wireless: ap.wireless && Array.isArray(ap.wireless.history) ? ap.wireless : (ap.wireless || { history: [] }),
        tooltipInfo: mergedTooltip,
        connectedTo,
        connectedPort,
        wiredSpeed
      };
    });
    
    if (import.meta?.env?.DEV && merged.length > 0) {
      console.log('[Dashboard] accessPoints (after merge):', {
        sample: {
          serial: merged[0].serial,
          wiredSpeed: merged[0].wiredSpeed,
          connectedTo: merged[0].connectedTo,
          hasWireless: !!merged[0].wireless,
          hasHistory: Array.isArray(merged[0].wireless?.history),
          historyLength: merged[0].wireless?.history?.length || 0,
          hasFailureHistory: Array.isArray(merged[0].wireless?.failureHistory),
          failureHistoryLength: merged[0].wireless?.failureHistory?.length || 0
        }
      });
    }
    
    return merged;
  }, [baseAccessPoints, enrichedApMap, statusMap]);

  const apStatusCounts = useMemo(() => {
    return accessPoints.reduce((acc, ap) => {
      const normalized = normalizeReachability(ap.status);
      if (normalized === 'connected') acc.connected += 1;
      else if (normalized === 'warning') acc.warning += 1;
      else if (normalized === 'disconnected') acc.disconnected += 1;
      return acc;
    }, { connected: 0, warning: 0, disconnected: 0 });
  }, [accessPoints]);

  const sortKey = sortConfig.key;
  const sortDirection = sortConfig.direction;
  const sortedAccessPoints = useMemo(() => sortData(accessPoints, sortKey, sortDirection), [accessPoints, sortKey, sortDirection]);

  useEffect(() => {
    hasAppliedPreferredRef.current = false;
  }, [summaryData]);

  useEffect(() => {
    const metaTimespan = summaryData?.applianceMetricsMeta?.uplinkTimespan;
    if (metaTimespan && Number(metaTimespan) !== Number(uplinkRange)) {
      setUplinkRange(Number(metaTimespan));
    }
  }, [summaryData?.applianceMetricsMeta?.uplinkTimespan, uplinkRange]);

  // Limpiar datos enriquecidos de APs cuando cambia la red
  useEffect(() => {
    setEnrichedAPs(null);
    setApDataSource(null);
    setLoadingLLDP(false);
    hasMarkedApsSectionRef.current = false; // Reset when network changes
    hasFetchedEnrichedApsRef.current = false;
  }, [selectedNetwork?.id]);

  useEffect(() => {
    // Solo usar datos del summary si NO tenemos datos LLDP ya cargados
    if (apDataSource === 'lldp') {
      return; // No sobreescribir datos LLDP con datos del summary
    }
    if (Array.isArray(summaryData?.accessPoints) && summaryData.accessPoints.length) {
      setEnrichedAPs(summaryData.accessPoints);
      setApDataSource('summary');
    }
  }, [summaryData?.accessPoints, apDataSource]);

  // Cargar datos completos de APs con LLDP/CDP cuando se selecciona access_points
  // Se dispara cuando: cambia la red, cambia la sección, o cuando el summary indica que hay APs
  const hasAccessPointsInSummary = Array.isArray(summaryData?.accessPoints) && summaryData.accessPoints.length > 0;
  
  useEffect(() => {
    // Esperar a que tengamos network ID y que la sección sea access_points
    if (!selectedNetwork?.id) return;
    if (section !== 'access_points') return;
    
    // Si ya cargamos LLDP para esta red, no volver a cargar
    if (hasFetchedEnrichedApsRef.current) {
      return;
    }

    // Iniciar carga LLDP
    const controller = new AbortController();

    const fetchEnrichedAPs = async () => {
      setLoadingLLDP(true);
      try {
        const url = `/api/networks/${selectedNetwork.id}/section/access_points`;
        const response = await fetchAPI(url, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json();
          if (data && Array.isArray(data.accessPoints)) {
            // Datos LLDP tienen prioridad - setear ANTES de marcar como fetched
            setApDataSource('lldp');
            setEnrichedAPs(data.accessPoints);
            hasFetchedEnrichedApsRef.current = true;
          }
        } else {
          console.error('Respuesta no OK:', response.status, response.statusText);
        }
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.error('Error cargando datos completos de APs:', err);
      } finally {
        setLoadingLLDP(false);
      }
    };

    fetchEnrichedAPs();

    return () => controller.abort();
  }, [selectedNetwork?.id, section, hasAccessPointsInSummary]); // Re-trigger cuando summary confirma que hay APs

  // Carga lazy de una sección específica
  const loadSection = useCallback(async (sectionKey, { force = false } = {}) => {
    if (!selectedNetwork?.id) return;
    
    // Si ya está cargada y no es force, skip
    if (loadedSections.has(sectionKey) && !force) {
        return;
      }
    
    setSectionLoading(sectionKey);
  console.debug(`Cargando sección '${sectionKey}'...`);
    
    try {
      const params = new URLSearchParams();
      if (sectionKey === 'appliance_status') {
        params.set('uplinkTimespan', uplinkRange || DEFAULT_UPLINK_TIMESPAN);
        params.set('uplinkResolution', DEFAULT_UPLINK_RESOLUTION);
      }
      
      const url = `/api/networks/${selectedNetwork.id}/section/${sectionKey}${params.toString() ? `?${params}` : ''}`;
      // Usar fetchAPI con anti-cache para datos frescos
      const response = await fetchAPI(url);
      
      if (!response.ok) {
        throw new Error(`Error cargando sección ${sectionKey}`);
      }
      
  const sectionData = await response.json();
      
      // Merge con summaryData existente
      setSummaryData(prev => {
        const merged = { ...prev };
        
        // Mapear los datos de la sección al formato de summaryData
        switch (sectionKey) {
          case 'topology':
            merged.topology = sectionData.topology;
            if (sectionData.devices && !prev?.devices) merged.devices = sectionData.devices;
            break;
          case 'switches':
            merged.switchesDetailed = sectionData.switchesDetailed;
            merged.switchesOverview = sectionData.switchesOverview;
            break;
          case 'access_points':
            merged.accessPoints = sectionData.accessPoints;
            break;
          case 'appliance_status':
            merged.applianceStatus = sectionData.applianceStatus;
            if (sectionData.topology) merged.topology = sectionData.topology;
            break;
        }
        
        return merged;
      });
      
      // Marcar como cargada
      setLoadedSections(prev => new Set(prev).add(sectionKey));
      
    } catch (error) {
  console.error(`Error cargando '${sectionKey}':`, error);
  setError(`Error cargando ${sectionKey}: ${error.message}`);
    } finally {
      setSectionLoading(null);
    }
  }, [selectedNetwork, loadedSections, uplinkRange]);

  const buildSummaryUrl = useCallback((networkId, { timespan, resolution, quick = true } = {}) => {
    const params = new URLSearchParams();
    const ts = timespan ?? uplinkRange ?? DEFAULT_UPLINK_TIMESPAN;
    const res = resolution ?? DEFAULT_UPLINK_RESOLUTION;
    if (ts) params.set('uplinkTimespan', ts);
    if (res) params.set('uplinkResolution', res);
    if (quick) params.set('quick', 'true'); // Modo rápido por defecto
    const query = params.toString();
    return `/api/networks/${networkId}/summary${query ? `?${query}` : ''}`;
  }, [uplinkRange]);

  const loadSummary = useCallback(async ({ networkId, timespan, resolution, keepPrevious = false }) => {
    if (!networkId) return null;

    if (!keepPrevious) {
      setSummaryData(null);
      setLoadedSections(new Set()); // Reset secciones cargadas
      setEnrichedAPs(null);
      setApDataSource(null);
      setLoadingLLDP(false);
      hasFetchedEnrichedApsRef.current = false;
    }

    try {
      const url = buildSummaryUrl(networkId, { timespan, resolution });
      // Usar fetchAPI con anti-cache para datos frescos en producción
      const response = await fetchAPI(url);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Error response:', errorText);
        throw new Error(`Error al cargar los datos del predio: ${response.status}`);
      }
      const data = await response.json();
      console.log('📦 [Dashboard] Summary response data:', data);
      console.log('📦 [Dashboard] Summary response data.accessPoints:', data.accessPoints);
      setSummaryData(data);
      
      // Marcar todas las secciones como cargadas (modo completo)
      setLoadedSections(new Set(['topology', 'switches', 'access_points', 'appliance_status']));
      

      
      // Enriquecer selectedNetwork con predio_code si está disponible
      if (data?.networkMetadata?.predioInfo?.predio_code) {
        setSelectedNetwork(prev => ({
          ...prev,
          predio_code: data.networkMetadata.predioInfo.predio_code
        }));
      }
      return data;
    } catch (error) {
      console.error('Error en loadSummary:', error);
      setError(error.message || 'Error al cargar el resumen del predio');
      throw error;
    }
  }, [buildSummaryUrl]);

  // Auto-cargar datos cuando hay initialNetwork (reload de página)
  useEffect(() => {
    if (initialNetwork && !hasAutoLoadedRef.current && !summaryData && !loading) {
      hasAutoLoadedRef.current = true;
      setLoading(true);
      
      loadSummary({ 
        networkId: initialNetwork.id, 
        timespan: DEFAULT_UPLINK_TIMESPAN, 
        resolution: DEFAULT_UPLINK_RESOLUTION, 
        keepPrevious: false
      })
      .then(() => {
        console.log('Datos auto-cargados desde reload');
      })
      .catch((err) => {
        console.error('Error auto-cargando datos:', err);
        setError(err.message || 'Error al cargar los datos del predio');
      })
      .finally(() => {
        setLoading(false);
      });
    }
  }, [initialNetwork, summaryData, loading, loadSummary]);

  useEffect(() => {
    if (!availableSections.length) return;

    const availableKeys = new Set(availableSections.map(item => item.k));

    if (!availableKeys.has(section)) {
      const fallback = (preferredSection && availableKeys.has(preferredSection))
        ? preferredSection
        : availableSections[0].k;
      if (fallback && fallback !== section) {
        setSection(fallback);
        hasAppliedPreferredRef.current = true;
      }
      return;
    }

    if (!hasAppliedPreferredRef.current && preferredSection && preferredSection !== section && availableKeys.has(preferredSection)) {
      setSection(preferredSection);
      hasAppliedPreferredRef.current = true;
    }
  }, [availableSections, preferredSection, section, setSection]);

  // Efecto para carga lazy cuando cambia de sección
  useEffect(() => {
    if (!selectedNetwork?.id || !section || !summaryData) return;
    
    // Access Points NO necesita loadSection, usa datos del summary directamente
    // El enriquecimiento LLDP se hace en background con el otro useEffect
    if (section === 'access_points') {
      // Marcar como cargada para evitar spinner innecesario - SOLO UNA VEZ
      if (!hasMarkedApsSectionRef.current) {
        hasMarkedApsSectionRef.current = true;
        setLoadedSections(prev => new Set(prev).add('access_points'));
      }
      return;
    }
    
    // Reset ref when changing away from access_points
    hasMarkedApsSectionRef.current = false;
    
    // Si la sección no está cargada, cargarla
    if (!loadedSections.has(section)) {
      loadSection(section);
    }
  }, [section, selectedNetwork, summaryData, loadSection]); // Removed loadedSections from dependencies to avoid infinite loop

  const search = async (q) => {
    setError('');
    setSummaryData(null);
    setLoadedSections(new Set());
    setUplinkRange(DEFAULT_UPLINK_TIMESPAN);
    if (!q) return;

    setLoading(true);
    try {
      // Usar siempre resolve-network que detecta automáticamente serial/MAC
      // Usar fetchAPI con anti-cache para datos frescos
      const resolveRes = await fetchAPI(`/api/resolve-network?q=${encodeURIComponent(q)}`);
      
      let network = null;
      
      if (resolveRes.ok) {
        const resolveData = await resolveRes.json();
        network = resolveData.network || (Array.isArray(resolveData.networks) && resolveData.networks[0]);
        console.log('🔍 Respuesta de resolve-network:', {
          source: resolveData.source,
          network: network,
          networkId: network?.id
        });
      } else if (resolveRes.status === 404) {
        // Predio no encontrado en catálogo, pero puede ser un network ID válido
        // Intentar usar el query como network ID directamente
  console.warn('Predio no encontrado en catálogo, intentando como network ID directo');
        network = { id: q, name: q };
      } else {
        throw new Error('Error al buscar el predio');
      }
      
      if (!network) throw new Error('No se pudo determinar el network del predio');
      
      console.log('Network a guardar:', network);
      setSelectedNetwork(network);
      
      // Guardar en predios recientes
      try {
        const recentPredios = JSON.parse(localStorage.getItem('recentPredios') || '[]');
        const newPredio = {
          id: network.predio_code || network.id,
          name: network.predio_name || network.name || '',
          timestamp: Date.now()
        };
        
        // Evitar duplicados y mantener los últimos 10
        const filtered = recentPredios.filter(p => p.id !== newPredio.id);
        const updated = [newPredio, ...filtered].slice(0, 10);
        localStorage.setItem('recentPredios', JSON.stringify(updated));
      } catch (e) {
        // Error al guardar en localStorage (silencioso)
      }
      
      // Cargar resumen completo (mantener para metadatos y flags)
      console.log('📡 Llamando loadSummary con networkId:', network.id);
      try {
        await loadSummary({ 
          networkId: network.id, 
          timespan: DEFAULT_UPLINK_TIMESPAN, 
          resolution: DEFAULT_UPLINK_RESOLUTION, 
          keepPrevious: false
        });
      } catch (loadError) {
        console.error('Error en loadSummary:', loadError);
        // No re-lanzar, ya está en error state
      }
      
      // La sección se cargará automáticamente por el useEffect

    } catch (e) {
      console.error('Error en handleSearch:', e);
      setError(e.message || 'Error buscando o cargando el predio');
    } finally {
      setLoading(false);
    }
  };

  const handleSort = (key) => {
    let direction = 'asc';
    if (sortConfig.key === key && sortConfig.direction === 'asc') {
      direction = 'desc';
    }
    setSortConfig({ key, direction });
  };

  // Funciones de captura y exportación
  const captureAndDownloadImage = async (sectionName) => {
    try {
      // Pequeño delay para asegurar renderizado completo
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const element = document.body;
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: true,
        foreignObjectRendering: true,
        removeContainer: true,
        imageTimeout: 0,
        onclone: (clonedDoc) => {
          // Asegurar que los SVG se rendericen correctamente
          const svgs = clonedDoc.querySelectorAll('svg');
          svgs.forEach(svg => {
            svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            const bbox = svg.getBBox();
            if (!svg.hasAttribute('width')) svg.setAttribute('width', bbox.width);
            if (!svg.hasAttribute('height')) svg.setAttribute('height', bbox.height);
          });
        }
      });
      
      const predioCode = selectedNetwork?.predio_code || selectedNetwork?.id || 'unknown';
      const fileName = `${sectionName} ${predioCode}.jpg`;
      
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        link.click();
        URL.revokeObjectURL(url);
      }, 'image/jpeg', 0.95);
    } catch (error) {
      console.error('Error capturando imagen:', error);
      alert('Error al generar la imagen. Por favor intenta nuevamente.');
    }
  };

  const captureAndDownloadPDF = async (sectionName) => {
    try {
      // Pequeño delay para asegurar renderizado completo
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const element = document.body;
      const canvas = await html2canvas(element, {
        scale: 2,
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#ffffff',
        logging: true,
        foreignObjectRendering: true,
        removeContainer: true,
        imageTimeout: 0,
        onclone: (clonedDoc) => {
          // Asegurar que los SVG se rendericen correctamente
          const svgs = clonedDoc.querySelectorAll('svg');
          svgs.forEach(svg => {
            svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
            const bbox = svg.getBBox();
            if (!svg.hasAttribute('width')) svg.setAttribute('width', bbox.width);
            if (!svg.hasAttribute('height')) svg.setAttribute('height', bbox.height);
          });
        }
      });
      
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      const pdf = new jsPDF({
        orientation: canvas.width > canvas.height ? 'landscape' : 'portrait',
        unit: 'px',
        format: [canvas.width, canvas.height]
      });
      
      pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width, canvas.height);
      
      const predioCode = selectedNetwork?.predio_code || selectedNetwork?.id || 'unknown';
      const fileName = `${sectionName} ${predioCode}.pdf`;
      pdf.save(fileName);
    } catch (error) {
      console.error('Error generando PDF:', error);
      alert('Error al generar el PDF. Por favor intenta nuevamente.');
    }
  };

  function sortData(data, key, direction) {
    if (!key) return data;
    
    const sorted = [...data].sort((a, b) => {
      let aVal = a[key];
      let bVal = b[key];
      
      // Normalizar valores
      if (key === 'status') {
        aVal = normalizeReachability(aVal);
        bVal = normalizeReachability(bVal);
      }
      
      if (aVal === null || aVal === undefined) aVal = '';
      if (bVal === null || bVal === undefined) bVal = '';
      
      if (typeof aVal === 'string') aVal = aVal.toLowerCase();
      if (typeof bVal === 'string') bVal = bVal.toLowerCase();
      
      if (aVal < bVal) return direction === 'asc' ? -1 : 1;
      if (aVal > bVal) return direction === 'asc' ? 1 : -1;
      return 0;
    });
    
    return sorted;
  }

  const SortableHeader = ({ label, sortKey, align = 'left', width }) => {
    const isActive = sortConfig.key === sortKey;
    const direction = isActive ? sortConfig.direction : null;
    
    return (
      <th 
        style={{ 
          textAlign: align,
          width: width,
          cursor: 'pointer', 
          userSelect: 'none',
          position: 'relative',
          paddingRight: '20px'
        }}
        onClick={() => handleSort(sortKey)}
      >
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
          {label}
          <span style={{ 
            display: 'inline-flex', 
            flexDirection: 'column', 
            marginLeft: '2px',
            opacity: isActive ? 1 : 0.3
          }}>
            <span style={{ 
              fontSize: '8px', 
              lineHeight: '6px',
              color: (isActive && direction === 'asc') ? '#2563eb' : '#94a3b8'
            }}>▲</span>
            <span style={{ 
              fontSize: '8px', 
              lineHeight: '6px',
              color: (isActive && direction === 'desc') ? '#2563eb' : '#94a3b8'
            }}>▼</span>
          </span>
        </div>
      </th>
    );
  };

  // El useEffect ya no es necesario para cargar secciones, ahora es síncrono
  
  const renderSection = () => {
    // Mostrar loading durante búsqueda inicial o carga de secciones
    if (loading || sectionLoading) {
      const message = sectionLoading 
        ? `Cargando ${sectionLoading === 'access_points' ? 'Access Points' : sectionLoading === 'switches' ? 'Switches' : sectionLoading === 'appliance_status' ? 'Appliances' : 'datos'}...`
        : 'Cargando datos del predio...';
      return <LoadingOverlay isLoading={true} message={message} variant="blur" />;
    }
  if (!selectedNetwork) return <div className="empty-predio">Busca un predio en la barra superior…</div>;
    if (!summaryData) return <div>No hay datos disponibles para este predio.</div>;

    const sectionAvailable = availableSections.some(item => item.k === section);
    if (!sectionAvailable) {
      return <div style={{ padding: '12px', color: '#64748b' }}>Selecciona una sección disponible.</div>;
    }

    switch (section) {
      case 'topology':
        // Mobile: render the same graph as desktop inside a pan/zoom-friendly wrapper.
        // IMPORTANT: This replaces the previous compact list for topology on mobile.
        // It intentionally keeps the same `SimpleGraph` component so desktop layout is unchanged.
        if (isMobile) {
          return (
            <div>
              <h2 style={{ margin: '0 0 12px 0', color: '#1e293b', fontSize: '20px', fontWeight: '600' }}>Topología</h2>
              {topology?.nodes && topology.nodes.length > 0 ? (
                <div className="mobile-topology-graph-wrapper">
                  <div className="mobile-topology-graph" role="region" aria-label="Topología - gráfico desplazable">
                    <div className="mobile-topology-graph-inner">
                      {/* Reuse the same SimpleGraph used on desktop; wrapping enables horizontal scroll/zoom on mobile */}
                      <Suspense fallback={<SkeletonTopology />}>
                        <SimpleGraph graph={topology} devices={topologyDevices} />
                      </Suspense>
                    </div>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '12px', color: '#57606a' }}>No hay datos de topología para este predio.</div>
              )}
            </div>
          );
        }

        return (
          <>
            <h2 style={{ 
              margin: '0 0 20px 0', 
              color: '#1e293b', 
              fontSize: '20px', 
              fontWeight: '600',
              borderBottom: '2px solid #cbd5e1',
              paddingBottom: '12px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {topology?.nodes && topology.nodes.length > 0 && (
                  <span style={{ 
                    fontSize: '14px', 
                    fontWeight: '600', 
                    color: '#065f46',
                    background: '#d1fae5',
                    padding: '8px 16px',
                    borderRadius: '8px',
                    border: '1px solid #22c55e',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    <span style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background: '#22c55e',
                      boxShadow: '0 0 4px rgba(34, 197, 94, 0.6)'
                    }}></span>
                    {(() => {
                      const onlineCount = topology.nodes.filter(n => {
                        const status = (n.status || '').toLowerCase();
                        return status === 'online' || status === 'connected' || status === 'active';
                      }).length;
                      return `${onlineCount} Dispositivo${onlineCount !== 1 ? 's' : ''} en Línea`;
                    })()}
                  </span>
                )}
                <span>Topología</span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => captureAndDownloadImage('Topologia')}
                  style={{
                    padding: '8px 16px',
                    background: '#2563eb',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '500',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  title="Descargar como JPG"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  JPG
                </button>
                <button
                  onClick={() => captureAndDownloadPDF('Topologia')}
                  style={{
                    padding: '8px 16px',
                    background: '#dc2626',
                    color: 'white',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    fontSize: '14px',
                    fontWeight: '500',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                  title="Descargar como PDF"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <polyline points="7 10 12 15 17 10"></polyline>
                    <line x1="12" y1="15" x2="12" y2="3"></line>
                  </svg>
                  PDF
                </button>
              </div>
            </h2>
            {topology?.nodes && topology.nodes.length > 0 ? (
              <div style={{ overflow: 'hidden' }}>
                <Suspense fallback={<SkeletonTopology />}>
                  <SimpleGraph graph={topology} devices={topologyDevices} />
                </Suspense>
              </div>
            ) : (
              <div style={{ padding: '12px', color: '#57606a' }}>
                No hay datos de topología para este predio. El backend intentará construir una si hay datos de conexión.
              </div>
            )}
          </>
        );

      case 'switches': {
        const switchesData = Array.isArray(switchesDetailed) && switchesDetailed.length 
          ? switchesDetailed 
          : devices.filter(d => d.model?.toLowerCase().startsWith('ms')).map(sw => {
              const ports = switchPorts.filter(p => p.serial === sw.serial);
              const connectedPorts = ports.filter(p => {
                if (p.enabled === false) return false;
                const normalized = normalizeReachability(p.statusNormalized || p.status);
                return normalized === 'connected';
              }).length;
              const poePorts = ports.filter(p => p.poeEnabled).length;
              const poeActivePorts = ports.filter(p => p.poeEnabled && p.poe?.status === 'delivering').length;
              
              return {
                ...sw,
                status: statusMap.get(sw.serial) || sw.status,
                totalPorts: ports.length,
                activePorts: connectedPorts,
                tooltipInfo: {
                  name: sw.name || sw.serial,
                  model: sw.model || '-',
                  serial: sw.serial || '-',
                  mac: sw.mac || '-',
                  firmware: sw.firmware || 'N/A',
                  lanIp: sw.lanIp || '-',
                  connectedPorts: connectedPorts,
                  totalPorts: ports.length,
                  poePorts: poePorts,
                  poeActivePorts: poeActivePorts,
                  connectedTo: sw.connectedTo || '-',
                  detectionMethod: sw.detectionMethod || 'LLDP'
                }
              };
            });

        if (!switchesData.length) {
          return (
            <div style={{ padding: '12px', color: '#57606a' }}>
              No hay switches para esta red
            </div>
          );
        }
        // Mobile optimized list
        if (isMobile) {
          const mobileList = sortData(switchesData, sortConfig.key, sortConfig.direction);
          return (
            <div>
              <h2 style={{ margin: '0 0 12px 0', color: '#1e293b', fontSize: '20px', fontWeight: '600' }}>Switches</h2>
              <div className="mobile-device-list">
                {mobileList.map((sw) => {
                  const statusColor = getStatusColor(sw.status);
                  const subline = sw.serial || sw.lanIp || sw.connectedTo || '';
                  const swTooltip = (sw.tooltipInfo || sw) ? (
                    <div>
                      <div className="tooltip-title">{(sw.tooltipInfo && sw.tooltipInfo.name) || sw.name || sw.serial}</div>
                      <div className="tooltip-row"><span className="tooltip-label">Modelo</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.model) || sw.model || '-'}</span></div>
                      <div className="tooltip-row"><span className="tooltip-label">Serial</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.serial) || sw.serial || '-'}</span></div>
                      <div className="tooltip-row"><span className="tooltip-label">Firmware</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.firmware) || sw.firmware || 'N/A'}</span></div>
                      <div className="tooltip-row"><span className="tooltip-label">LAN IP</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.lanIp) || sw.lanIp || '-'}</span></div>
                      <div className="tooltip-row"><span className="tooltip-label">Puertos activos</span><span className="tooltip-value">{(sw.tooltipInfo && (sw.tooltipInfo.connectedPorts != null ? sw.tooltipInfo.connectedPorts : null)) ?? sw.activePorts ?? (sw.connectedPorts || 0)}/{(sw.tooltipInfo && (sw.tooltipInfo.totalPorts != null ? sw.tooltipInfo.totalPorts : null)) ?? sw.totalPorts ?? (sw.ports ? sw.ports.length : '-')}</span></div>
                      {((sw.tooltipInfo && sw.tooltipInfo.poePorts) || sw.poePorts) ? (
                        <div className="tooltip-row"><span className="tooltip-label">PoE</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.poeActivePorts) || sw.poeActivePorts || 0}/{(sw.tooltipInfo && sw.tooltipInfo.poePorts) || sw.poePorts || 0} activos</span></div>
                      ) : null}
                      {(sw.tooltipInfo && sw.tooltipInfo.connectedTo) || sw.connectedTo ? (
                        <div className="tooltip-row"><span className="tooltip-label">Conectado a</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.connectedTo) || sw.connectedTo}</span></div>
                      ) : null}
                      {(sw.tooltipInfo && sw.tooltipInfo.detectionMethod) || sw.detectionMethod ? (
                        <div className="tooltip-row"><span className="tooltip-label">Detección</span><span className="tooltip-value">{(sw.tooltipInfo && sw.tooltipInfo.detectionMethod) || sw.detectionMethod}</span></div>
                      ) : null}
                    </div>
                  ) : null;

                  return (
                    <div key={sw.serial} className="mobile-device-item">
                      <Tooltip content={swTooltip || "Switch"} position="auto" modalOnMobile={true}>
                        <button className="mobile-device-button" style={{ display: 'flex', alignItems: 'center', width: '100%', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
                            <div className="mobile-device-icon"><SwitchIcon /></div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, color: '#2563eb', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sw.name || sw.serial}</div>
                              <div className="mobile-device-subline">{subline}</div>
                            </div>
                            <div style={{ marginLeft: 8, flex: '0 0 auto' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: normalizeReachability(sw.status) === 'connected' ? '#d1fae5' : '#fee2e2' }}>
                                <span style={{ width: 9, height: 9, borderRadius: '50%', background: statusColor }} />
                              </span>
                            </div>
                          </div>
                        </button>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18, overflow: 'visible' }}>
            <h2 style={{ 
              margin: '0 0 12px 0', 
              color: '#1e293b', 
              fontSize: '20px', 
              fontWeight: '600',
              borderBottom: '2px solid #cbd5e1',
              paddingBottom: '12px'
            }}>
              Switches
            </h2>

            {/* Tabs */}
            <div style={{ 
              display: 'flex', 
              gap: '8px', 
              borderBottom: '1px solid #cbd5e1',
              marginBottom: '16px'
            }}>
              <button
                onClick={() => setSwitchesTab('list')}
                style={{
                  padding: '8px 16px',
                  background: 'none',
                  border: 'none',
                  borderBottom: switchesTab === 'list' ? '2px solid #2563eb' : '2px solid transparent',
                  color: switchesTab === 'list' ? '#2563eb' : '#64748b',
                  fontWeight: switchesTab === 'list' ? '600' : '500',
                  fontSize: '14px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
              >
                Switches
              </button>
              <button
                onClick={() => setSwitchesTab('ports')}
                style={{
                  padding: '8px 16px',
                  background: 'none',
                  border: 'none',
                  borderBottom: switchesTab === 'ports' ? '2px solid #2563eb' : '2px solid transparent',
                  color: switchesTab === 'ports' ? '#2563eb' : '#64748b',
                  fontWeight: switchesTab === 'ports' ? '600' : '500',
                  fontSize: '14px',
                  cursor: 'pointer',
                  transition: 'all 0.2s ease'
                }}
              >
                Puertos
              </button>
            </div>

            {/* Contenido según tab */}
            {switchesTab === 'list' ? (
              <>
                {switchesOverview && (
                  <div style={{ 
                    display: 'flex', 
                    flexWrap: 'wrap', 
                    gap: '12px', 
                    marginBottom: '20px',
                    padding: '14px',
                    background: '#f1f5f9',
                    borderRadius: '10px'
                  }}>
                    <SummaryChip label="Total Switches" value={switchesOverview.totalSwitches} accent="#1f2937" />
                    <SummaryChip 
                      label="Online" 
                      value={switchesData.filter(sw => normalizeReachability(sw.status) === 'connected').length} 
                      accent="#22c55e" 
                    />
                    <SummaryChip 
                      label="Advertencia" 
                      value={switchesData.filter(sw => normalizeReachability(sw.status) === 'warning').length} 
                      accent="#f59e0b" 
                    />
                    <SummaryChip 
                      label="Offline" 
                      value={switchesData.filter(sw => normalizeReachability(sw.status) === 'disconnected').length} 
                      accent="#ef4444" 
                    />
                  </div>
                )}

                <div style={{ position: 'relative', overflow: 'visible' }}>
                  <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid #cbd5e1' }}>
                    <table className="modern-table" style={{ minWidth: '1200px', width: '100%' }}>
                    <thead>
                      <tr>
                        <SortableHeader label="Status" sortKey="status" align="center" width="100px" />
                        <SortableHeader label="Name" sortKey="name" align="left" width="220px" />
                        <SortableHeader label="Model" sortKey="model" align="left" width="150px" />
                        <SortableHeader label="Serial" sortKey="serial" align="left" width="180px" />
                        <th style={{ textAlign: 'left', minWidth: '280px' }}>Connectivity (UTC-3)</th>
                        <SortableHeader label="MAC address" sortKey="mac" align="left" width="180px" />
                        <SortableHeader label="LAN IP" sortKey="lanIp" align="left" width="120px" />
                      </tr>
                    </thead>
                    <tbody>
                      {sortData(switchesData, sortConfig.key, sortConfig.direction).map((sw) => {
                        const statusColor = getStatusColor(sw.status);
                        const statusNormalized = normalizeReachability(sw.status);
                        
                        // Construir tooltip para la tabla (igual que en SwitchCard)
                        const switchTooltip = sw.tooltipInfo ? (
                          <div>
                            <div className="tooltip-title">{sw.tooltipInfo.name}</div>
                            <div className="tooltip-row">
                              <span className="tooltip-label">Modelo</span>
                              <span className="tooltip-value">{sw.tooltipInfo.model}</span>
                            </div>
                            <div className="tooltip-row">
                              <span className="tooltip-label">Serial</span>
                              <span className="tooltip-value">{sw.tooltipInfo.serial}</span>
                            </div>
                            {sw.tooltipInfo.mac && (
                              <div className="tooltip-row">
                                <span className="tooltip-label">MAC</span>
                                <span className="tooltip-value">{sw.tooltipInfo.mac}</span>
                              </div>
                            )}
                            <div className="tooltip-row">
                              <span className="tooltip-label">Firmware</span>
                              <span className="tooltip-value">{sw.tooltipInfo.firmware || 'N/A'}</span>
                            </div>
                            <div className="tooltip-row">
                              <span className="tooltip-label">LAN IP</span>
                              <span className="tooltip-value">{sw.tooltipInfo.lanIp || 'N/A'}</span>
                            </div>
                            <div className="tooltip-row">
                              <span className="tooltip-label">Puertos activos</span>
                              <span className="tooltip-value">{sw.tooltipInfo.connectedPorts}/{sw.tooltipInfo.totalPorts}</span>
                            </div>
                            {sw.tooltipInfo.poePorts > 0 && (
                              <div className="tooltip-row">
                                <span className="tooltip-label">PoE</span>
                                <span className="tooltip-value">{sw.tooltipInfo.poeActivePorts}/{sw.tooltipInfo.poePorts} activos</span>
                              </div>
                            )}
                            {sw.tooltipInfo.connectedTo && sw.tooltipInfo.connectedTo !== '-' && (
                              <>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">Conectado a</span>
                                  <span className="tooltip-value">{sw.tooltipInfo.connectedTo}</span>
                                </div>
                                <div className="tooltip-row">
                                  <span className="tooltip-label">Detección</span>
                                  <span className="tooltip-value">{sw.tooltipInfo.detectionMethod}</span>
                                </div>
                              </>
                            )}
                          </div>
                        ) : null;
                        
                        // Tooltip para el indicador de status con razón del warning
                        const getStatusTooltip = () => {
                          const baseText = 
                            statusNormalized === 'connected' ? 'Conectado' :
                            statusNormalized === 'disconnected' ? 'Desconectado' :
                            statusNormalized === 'warning' ? 'Advertencia' : 'Desconocido';
                          
                          if (statusNormalized === 'warning' && sw.statusReason) {
                            return (
                              <div style={{ maxWidth: '280px' }}>
                                <div style={{ fontWeight: 600, marginBottom: '4px', color: '#f59e0b' }}>{baseText}</div>
                                <div style={{ fontSize: '12px', color: '#64748b' }}>{sw.statusReason}</div>
                              </div>
                            );
                          }
                          return baseText;
                        };
                        
                        return (
                          <tr key={sw.serial}>
                            <td style={{ textAlign: 'center', padding: '10px 6px' }}>
                              <Tooltip content={getStatusTooltip()} position="right">
                                <span 
                                  style={{ 
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    width: '22px',
                                    height: '22px',
                                    borderRadius: '50%',
                                    background: statusNormalized === 'connected' ? '#d1fae5' : statusNormalized === 'warning' ? '#fef3c7' : statusNormalized === 'disconnected' ? '#fee2e2' : '#f1f5f9',
                                    cursor: statusNormalized === 'warning' ? 'help' : 'default'
                                  }}
                                >
                                  <span style={{ 
                                    width: '9px', 
                                    height: '9px', 
                                    borderRadius: '50%', 
                                    background: statusNormalized === 'connected' ? '#22c55e' : statusNormalized === 'warning' ? '#f59e0b' : statusNormalized === 'disconnected' ? '#ef4444' : '#94a3b8'
                                  }} />
                                </span>
                              </Tooltip>
                            </td>
                            <td style={{ textAlign: 'left', fontSize: '14px', padding: '10px 12px', overflow: 'visible', position: 'relative' }}>
                              <Tooltip content={switchTooltip || "Switch sin tooltipInfo"} position="auto">
                                <span style={{ 
                                  color: '#2563eb', 
                                  fontWeight: '700',
                                  cursor: 'pointer',
                                  display: 'inline-block',
                                  position: 'relative',
                                  zIndex: 1
                                }}>
                                  {sw.name || sw.serial}
                                </span>
                              </Tooltip>
                            </td>
                            <td style={{ textAlign: 'left', fontSize: '13px', color: '#64748b', padding: '10px 12px' }}>
                              {sw.model || '-'}
                            </td>
                            <td style={{ textAlign: 'left', fontSize: '12px', color: '#64748b', padding: '10px 12px', fontFamily: 'monospace' }}>
                              {sw.serial}
                            </td>
                            <td style={{ padding: '10px 12px' }}>
                              <ConnectivityBar device={sw} />
                            </td>
                            <td style={{ textAlign: 'left', fontSize: '12px', color: '#64748b', padding: '10px 12px', fontFamily: 'monospace' }}>
                              {sw.mac || '-'}
                            </td>
                            <td style={{ textAlign: 'left', fontSize: '13px', color: '#64748b', padding: '10px 12px', fontFamily: 'monospace' }}>
                              {sw.lanIp || '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    </table>
                  </div>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 18, overflow: 'visible' }}>
                  {switchesDetailed && switchesDetailed.length > 0 ? (
                    switchesDetailed.map(sw => (
                      <SwitchCard key={sw.serial} sw={sw} />
                    ))
                  ) : (
                    <div style={{ padding: '12px', color: '#64748b' }}>
                      No hay información detallada de puertos disponible
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        );
      }

      case 'access_points': {
        const wirelessSummary = wirelessInsights?.summary || null;

        if (!accessPoints.length) {
          return (
            <div style={{ padding: '12px', color: '#64748b' }}>
              No se encontraron Access Points en este predio.
            </div>
          );
        }

        // Badge de carga LLDP
        if (import.meta?.env?.DEV) {
          console.log('🔄 [Dashboard] loadingLLDP:', loadingLLDP);
        }
        const lldpBadge = loadingLLDP && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 16px',
            background: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: '600',
            color: '#1e40af',
            animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite'
          }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Actualizando velocidades LLDP...
          </div>
        );
        
        if (!accessPoints.length) {
          return (
            <div style={{ padding: '12px', color: '#64748b' }}>
              No se encontraron Access Points en este predio.
            </div>
          );
        }

        // Forzar vista de tabla siempre (sin tarjetas de wireless)
        const hasWireless = false; // Cambiado a false para siempre mostrar tabla
        // Mobile optimized list for APs
        if (isMobile) {
          const mobileAps = sortedAccessPoints;
          return (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '12px', flexWrap: 'wrap' }}>
                <h2 style={{ margin: 0, color: '#1e293b', fontSize: '20px', fontWeight: '600' }}>Wireless</h2>
                {lldpBadge}
              </div>
              <div className="mobile-device-list">
                {mobileAps.map((d) => {
                  const statusColor = getStatusColor(d.status);
                  const subline = d.serial || d.lanIp || d.connectedTo || '';

                  // Construir contenido seguro para tooltip (no pasar objetos crudos)
                  const apTooltip = d.tooltipInfo ? (
                    <div>
                      <div className="tooltip-title">{d.tooltipInfo.name}</div>
                      {d.tooltipInfo.model && (
                        <div className="tooltip-row"><span className="tooltip-label">Modelo</span><span className="tooltip-value">{d.tooltipInfo.model}</span></div>
                      )}
                      {d.tooltipInfo.serial && (
                        <div className="tooltip-row"><span className="tooltip-label">Serial</span><span className="tooltip-value">{d.tooltipInfo.serial}</span></div>
                      )}
                      {d.tooltipInfo.mac && (
                        <div className="tooltip-row"><span className="tooltip-label">MAC</span><span className="tooltip-value">{d.tooltipInfo.mac}</span></div>
                      )}
                      {d.tooltipInfo.firmware && (
                        <div className="tooltip-row"><span className="tooltip-label">Firmware</span><span className="tooltip-value">{d.tooltipInfo.firmware}</span></div>
                      )}
                      {d.tooltipInfo.lanIp && (
                        <div className="tooltip-row"><span className="tooltip-label">LAN IP</span><span className="tooltip-value">{d.tooltipInfo.lanIp}</span></div>
                      )}
                      {d.tooltipInfo.signalQuality != null && (
                        <div className="tooltip-row"><span className="tooltip-label">Calidad señal</span><span className="tooltip-value">{d.tooltipInfo.signalQuality}%</span></div>
                      )}
                      {!isMobile && d.tooltipInfo.clients != null && (
                        <div className="tooltip-row"><span className="tooltip-label">Clientes</span><span className="tooltip-value">{d.tooltipInfo.clients}</span></div>
                      )}
                      {!isMobile && d.tooltipInfo.microDrops > 0 && (
                        <div className="tooltip-row"><span className="tooltip-label">Microcortes</span><span className="tooltip-badge error">{d.tooltipInfo.microDrops}</span></div>
                      )}
                      {d.tooltipInfo.connectedTo && d.tooltipInfo.connectedTo !== '-' && (
                        <div className="tooltip-row"><span className="tooltip-label">Conectado a</span><span className="tooltip-value">{d.tooltipInfo.connectedTo}</span></div>
                      )}
                      {d.tooltipInfo.wiredSpeed && d.tooltipInfo.wiredSpeed !== '-' && (
                        <div className="tooltip-row"><span className="tooltip-label">Velocidad Ethernet</span><span className="tooltip-value">{d.tooltipInfo.wiredSpeed}</span></div>
                      )}
                    </div>
                  ) : null;

                  return (
                    <div key={d.serial || d.mac || d.name} className="mobile-device-item">
                      <Tooltip content={apTooltip} position="auto" modalOnMobile={true}>
                        <button type="button" className="mobile-device-button" style={{ display: 'flex', alignItems: 'center', width: '100%', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%' }}>
                            <div className="mobile-device-icon"><WifiIcon /></div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 700, color: '#2563eb', fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name || d.serial}</div>
                              <div className="mobile-device-subline">{subline}</div>
                            </div>
                            <div style={{ marginLeft: 8, flex: '0 0 auto' }}>
                              <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: '50%', background: normalizeReachability(d.status) === 'connected' ? '#d1fae5' : '#fee2e2' }}>
                                <span style={{ width: 9, height: 9, borderRadius: '50%', background: statusColor }} />
                              </span>
                            </div>
                          </div>
                        </button>
                      </Tooltip>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        if (!hasWireless) {
          return (
            <div>
              <h2 style={{ 
                margin: '0 0 12px 0', 
                color: '#1e293b', 
                fontSize: '20px', 
                fontWeight: '600',
                borderBottom: '2px solid #cbd5e1',
                paddingBottom: '12px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '12px'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <span>Wireless</span>
                  {lldpBadge}
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => captureAndDownloadImage('Access Points')}
                    style={{
                      padding: '8px 16px',
                      background: '#2563eb',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                    title="Descargar como JPG"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    JPG
                  </button>
                  <button
                    onClick={() => captureAndDownloadPDF('Access Points')}
                    style={{
                      padding: '8px 16px',
                      background: '#dc2626',
                      color: 'white',
                      border: 'none',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      fontSize: '14px',
                      fontWeight: '500',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px'
                    }}
                    title="Descargar como PDF"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    PDF
                  </button>
                </div>
              </h2>
              <div style={{ 
                display: 'flex', 
                flexWrap: 'wrap', 
                gap: '12px', 
                marginBottom: '20px',
                padding: '14px',
                background: '#f1f5f9',
                borderRadius: '10px'
              }}>
                <SummaryChip label="Total APs" value={accessPoints.length} accent="#1f2937" />
                <SummaryChip 
                  label="Online" 
                  value={apStatusCounts.connected} 
                  accent="#22c55e" 
                />
                <SummaryChip 
                  label="Advertencia" 
                  value={apStatusCounts.warning} 
                  accent="#f59e0b" 
                />
                <SummaryChip 
                  label="Offline" 
                  value={apStatusCounts.disconnected} 
                  accent="#ef4444" 
                />
              </div>

              <div style={{ position: 'relative', overflow: 'visible' }}>
                <div style={{ overflowX: 'auto', borderRadius: '12px', border: '1px solid #cbd5e1' }}>
                  <table className="modern-table" style={{ minWidth: '1400px', width: '100%' }}>
                  <thead>
                    <tr>
                      <SortableHeader label="Status" sortKey="status" align="center" width="80px" />
                      <SortableHeader label="Name" sortKey="name" align="left" width="150px" />
                      <th style={{ textAlign: 'left', minWidth: '300px' }}>Connectivity (UTC-3)</th>
                      <SortableHeader label="Serial number" sortKey="serial" align="left" width="180px" />
                      <SortableHeader label="Ethernet 1" sortKey="wiredSpeed" align="left" width="150px" />
                      <SortableHeader label="Ethernet 1 LLDP" sortKey="connectedTo" align="left" width="220px" />
                      <SortableHeader label="MAC address" sortKey="mac" align="left" width="180px" />
                      <th style={{ textAlign: 'left', minWidth: '130px' }}>Local IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedAccessPoints.map((d) => (
                      <AccessPointRow
                        key={d.serial || d.mac || d.name}
                        ap={d}
                        isDesktop={!isMobile}
                        networkId={summaryData?.networkMetadata?.networkInfo?.id}
                        orgId={summaryData?.networkMetadata?.organizationId}
                        isLLDPLoaded={apDataSource === 'lldp'}
                      />
                    ))}
                  </tbody>
                  </table>
                </div>
              </div>
            </div>
          );
        }

        const totalMicroDrops = accessPoints.reduce((acc, ap) => acc + (ap.wireless?.microDrops ?? ap.wireless?.signalSummary?.microDrops ?? 0), 0);
        const totalMicroDuration = accessPoints.reduce((acc, ap) => acc + (ap.wireless?.microDurationSeconds ?? ap.wireless?.signalSummary?.microDurationSeconds ?? 0), 0);

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <h2 style={{ 
              margin: '0 0 20px 0', 
              color: '#1e293b', 
              fontSize: '20px', 
              fontWeight: '600',
              borderBottom: '2px solid #cbd5e1',
              paddingBottom: '12px'
            }}>
              Wireless
            </h2>
            {(wirelessSummary || accessPoints.length) && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                {wirelessSummary && (
                  <>
                    <SummaryChip label="Calidad media red" value={formatQualityScore(wirelessSummary.average)} accent="#2563eb" />
                    <SummaryChip label="Cobertura" value={formatCoverage(wirelessSummary.coverage)} accent="#0f766e" />
                  </>
                )}
                <SummaryChip label="AP monitoreados" value={accessPoints.length} accent="#1f2937" />
                <SummaryChip label="Microcortes 24h" value={`${totalMicroDrops} · ${formatDuration(totalMicroDuration)}`} accent="#f97316" />
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 18 }}>
              {accessPoints.map((ap) => (
                <AccessPointCard key={ap.serial} ap={ap} isLLDPLoaded={apDataSource === 'lldp'} />
              ))}
            </div>
          </div>
        );
      }

      case 'appliance_status': {
        if (!applianceStatus.length) {
          return <div style={{ padding: '12px', color: '#57606a' }}>No se encontraron datos del appliance para este predio.</div>;
        }

        // Mobile compact list/cards for appliances
        if (isMobile) {
          return (
            <div>
              <h2 style={{ margin: '0 0 12px 0', color: '#1e293b', fontSize: '20px', fontWeight: '600' }}>Appliance</h2>
              <div className="mobile-appliance-list">
                {applianceStatus.map((appliance) => {
                  const uplinks = Array.isArray(appliance.uplinks) ? appliance.uplinks : [];
                  const activeUplink = uplinks.find(u => normalizeReachability(u.statusNormalized || u.status) === 'connected') || uplinks[0] || {};
                  const statusNormalized = normalizeReachability(activeUplink.statusNormalized || activeUplink.status || appliance.device?.status);
                  const color = statusNormalized === 'connected' ? '#22c55e' : statusNormalized === 'disconnected' ? '#ef4444' : '#f59e0b';

                  // Determine connected ports for this appliance (derived from topology or port list)
                  const connectedFromTopology = deriveConnectedPortsFromTopology(appliance.device?.serial, summaryData?.topology || null) || [];
                  // also check ports that have a carrier (enriched) if available
                  const portsList = Array.isArray(appliance.ports) ? appliance.ports : [];
                  const portsNums = portsList.map(p => parseInt(p.number, 10)).filter(Number.isFinite);
                  const connectedFromPorts = portsList.filter((p) => {
                    const norm = (p.statusNormalized || p.status || '').toString().toLowerCase();
                    return norm.includes('connected') || p.hasCarrier === true || (p.uplink && normalizeReachability(p.uplink.status) === 'connected');
                  }).map(p => parseInt(p.number, 10)).filter(Number.isFinite);

                  // Merge unique port numbers (topology-derived first)
                  const mergedPortsSet = new Set([...connectedFromTopology, ...connectedFromPorts]);
                  const mergedPorts = Array.from(mergedPortsSet).sort((a, b) => a - b);

                  // Determine unused ports (present in portsList but not in mergedPorts)
                  const unusedPorts = portsNums.filter(n => !mergedPortsSet.has(n)).sort((a,b)=>a-b);

                  // WAN interface badges
                  const uplinkIfaces = Array.isArray(appliance.uplinks) ? appliance.uplinks : [];
                  const wanBadges = uplinkIfaces.map((u) => {
                    const iface = (u.interface || u.name || '').toString();
                    const connected = normalizeReachability(u.statusNormalized || u.status) === 'connected';
                    return { iface, connected, ip: u.ip || u.publicIp || '' };
                  });

                  return (
                    <div key={appliance.device?.serial || appliance.device?.mac} className="mobile-appliance-card" role="button" onClick={() => setSection('appliance_status')}>
                      <div className="mobile-appliance-left">
                        <div className="mobile-appliance-icon"><ServerIcon /></div>
                      </div>
                      <div className="mobile-appliance-main">
                        <div className="mobile-appliance-title">{appliance.device?.model || appliance.device?.name}</div>
                        <div className="mobile-appliance-sub">{appliance.device?.name || appliance.device?.serial}</div>
                        <div className="mobile-appliance-meta">
                          {appliance.device?.mac && <span className="meta-item">MAC: <strong>{appliance.device.mac}</strong></span>}
                        </div>

                        {/* Ports: show full ordered sequence; highlight those in use */}
                        <div className="mobile-appliance-ports">
                          {(() => {
                            const allPortsSorted = Array.from(new Set([...portsNums])).sort((a, b) => a - b);
                            const maxShow = 16;
                            return (
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                {allPortsSorted.length > 0 ? allPortsSorted.slice(0, maxShow).map((p) => (
                                  <span key={`p-${p}`} className={`ap-port-badge ${mergedPortsSet.has(p) ? 'used' : 'unused'}`}>P{p}</span>
                                )) : <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>—</div>}
                                {allPortsSorted.length > maxShow && <div style={{ fontSize: 12, color: '#64748b' }}>+{allPortsSorted.length - maxShow}</div>}
                              </div>
                            );
                          })()}
                        </div>

                        {/* WAN badges + Estado (Estado refiere a la WAN activa) */}
                        {wanBadges.length > 0 && (
                          <div className="mobile-appliance-wan">
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                              {wanBadges.map((wb, idx) => (
                                <div key={`wan-${idx}`} className={`ap-wan-badge ${wb.connected ? 'active' : 'inactive'}`} title={wb.ip || ''}>
                                  {wb.iface || `wan${idx+1}`}
                                  {wb.ip ? <span style={{ marginLeft: 6, fontWeight: 600, fontSize: 12 }}>{wb.ip}</span> : null}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Estado moved below everything and left-aligned (refers to active WAN) */}
                        <div className="mobile-appliance-status-row">
                          <div className="mobile-appliance-status-label">Estado:</div>
                          <span className="mobile-appliance-status" style={{ background: color, color: '#fff', padding: '6px 10px', borderRadius: 999, fontWeight: 700 }}>{statusNormalized === 'connected' ? 'Connected' : statusNormalized}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        }

        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <h2 style={{ 
              margin: '0 0 20px 0', 
              color: '#1e293b', 
              fontSize: '20px', 
              fontWeight: '600',
              borderBottom: '2px solid #cbd5e1',
              paddingBottom: '12px'
            }}>
              Appliance status
            </h2>

            {applianceStatus.map((appliance) => {
              const uplinks = Array.isArray(appliance.uplinks) ? appliance.uplinks : [];
              
              // Encontrar el uplink activo (wan1 o wan2)
              const activeUplink = uplinks.find(uplink => 
                normalizeReachability(uplink.statusNormalized || uplink.status) === 'connected'
              ) || uplinks[0]; // Si ninguno está conectado, mostrar el primero

              if (!activeUplink) return null;

              const statusNormalized = normalizeReachability(activeUplink.statusNormalized || activeUplink.status || activeUplink.reachability);
              const color = statusNormalized === 'connected' ? '#22c55e' : statusNormalized === 'disconnected' ? '#ef4444' : '#f59e0b';
              
              const dnsLabel = (() => {
                if (Array.isArray(activeUplink.dns)) return activeUplink.dns.join(', ');
                const parts = [activeUplink.dns, activeUplink.dnsSecondary].filter(Boolean);
                return parts.length ? parts.join(' · ') : '-';
              })();

              // Buscar el historial del uplink activo
              const findHistorySeries = (iface) => {
                if (!iface || !Array.isArray(appliance.uplinkHistory)) return null;
                const normalized = iface.toString().toLowerCase();
                return appliance.uplinkHistory.find((series) => (series.interface || '').toLowerCase() === normalized);
              };

              const historySeries = findHistorySeries(activeUplink.interface);
              
              // Construir tooltip para el appliance
              const applianceTooltip = (
                <div>
                  <div className="tooltip-title">{appliance.device.name || appliance.device.serial}</div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Modelo</span>
                    <span className="tooltip-value">{appliance.device.model || '-'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Serial</span>
                    <span className="tooltip-value">{appliance.device.serial || '-'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">MAC</span>
                    <span className="tooltip-value">{appliance.device.mac || '-'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Firmware</span>
                    <span className="tooltip-value">{appliance.device.firmware || 'N/A'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">LAN IP</span>
                    <span className="tooltip-value">{appliance.device.lanIp || '-'}</span>
                  </div>
                  <div className="tooltip-row">
                    <span className="tooltip-label">Status</span>
                    <span className={`tooltip-badge ${statusNormalized === 'connected' ? 'success' : statusNormalized === 'disconnected' ? 'error' : 'warning'}`}>
                      {appliance.device.status}
                    </span>
                  </div>
                </div>
              );

              return (
                <div key={appliance.device.serial} style={{ border: '1px solid #cbd5e1', borderRadius: 12, padding: '20px', background: '#fff', display: 'flex', flexDirection: 'column', gap: 20 }}>
                  {/* Header del appliance */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, paddingBottom: 16, borderBottom: '2px solid #e2e8f0' }}>
                    <div>
                      <Tooltip content={applianceTooltip} position="right">
                        <h3 style={{ margin: 0, fontSize: '1.2em', color: '#1e293b', cursor: 'help' }}>{appliance.device.name || appliance.device.mac}</h3>
                      </Tooltip>
                      <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                        <span>LAN IP: <b>{appliance.device.lanIp || '-'}</b></span>
                      </div>
                    </div>
                    <span style={{ 
                      background: color === '#22c55e' ? '#d1fae5' : color === '#ef4444' ? '#fee2e2' : '#fef3c7',
                      color: color,
                      padding: '6px 16px',
                      borderRadius: 999,
                      fontSize: 13,
                      fontWeight: 600
                    }}>
                      {appliance.device.status}
                    </span>
                  </div>

                  {/* Contenido principal: Puertos y WAN lado a lado */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 20, alignItems: 'start' }}>
                    {/* Matriz de puertos */}
                    <div>
                      {(() => {
                        const connectedOverrides = deriveConnectedPortsFromTopology(appliance.device?.serial, topology);
                        const enrichedPorts = enrichPortsWithConnections(appliance.ports, appliance.device?.serial, topology);
                        
                        // Calcular deviceCount para detectar USAP (>3 APs + tiene MX)
                        const deviceCount = {
                          aps: Array.isArray(devices) ? devices.filter(d => (d.model || '').toLowerCase().startsWith('mr')).length : 0,
                          hasMX: applianceStatus.some(a => (a.device?.model || '').toUpperCase().startsWith('MX'))
                        };
                        
                        return (
                          <AppliancePortsMatrix
                            ports={enrichedPorts}
                            model={appliance.device?.model}
                            uplinks={appliance.uplinks}
                            connectedOverrides={connectedOverrides}
                            networkName={selectedNetwork?.name || selectedNetwork?.predio_name || ''}
                            deviceCount={deviceCount}
                          />
                        );
                      })()}
                    </div>

                    {/* Card del WAN activo - Optimizado */}
                    <div style={{ border: '1px solid #cbd5e1', borderRadius: 10, padding: 14, background: '#f8fafc', display: 'flex', flexDirection: 'column', gap: 10, height: 'fit-content', maxWidth: '420px' }}>
                      {/* Título WAN Interface */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1e293b' }}>{activeUplink.interface}</h4>
                        <span style={{ 
                          background: color, 
                          color: '#fff', 
                          padding: '3px 10px', 
                          borderRadius: 999, 
                          fontSize: 11,
                          fontWeight: 600
                        }}>
                          {statusNormalized === 'connected' ? 'active' : 'not connected'}
                        </span>
                      </div>
                      
                      {/* Información del dispositivo */}
                      <div style={{ padding: '10px', background: '#ffffff', borderRadius: 6, border: '1px solid #e2e8f0', marginBottom: 6 }}>
                        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Dispositivo</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 8px', fontSize: 12 }}>
                          <span style={{ color: '#64748b' }}>Modelo:</span>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>{appliance.device.model || '-'}</span>
                          
                          <span style={{ color: '#64748b' }}>Serial:</span>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>{appliance.device.serial || '-'}</span>
                          
                          <span style={{ color: '#64748b' }}>MAC:</span>
                          <span style={{ fontWeight: 600, color: '#1e293b' }}>{appliance.device.mac || '-'}</span>
                        </div>
                      </div>

                      {/* Información WAN - Solo campos con datos */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', fontSize: 12 }}>
                        {activeUplink.ip && (
                          <>
                            <span style={{ color: '#64748b' }}>IP:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.ip}</span>
                          </>
                        )}
                        
                        {activeUplink.publicIp && (
                          <>
                            <span style={{ color: '#64748b' }}>Public IP:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.publicIp}</span>
                          </>
                        )}
                        
                        {activeUplink.gateway && (
                          <>
                            <span style={{ color: '#64748b' }}>Gateway:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.gateway}</span>
                          </>
                        )}
                        
                        {dnsLabel && dnsLabel !== '-' && (
                          <>
                            <span style={{ color: '#64748b' }}>DNS:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{dnsLabel}</span>
                          </>
                        )}
                        
                        {activeUplink.loss != null && (
                          <>
                            <span style={{ color: '#64748b' }}>Loss:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.loss}%</span>
                          </>
                        )}
                        
                        {activeUplink.latency != null && (
                          <>
                            <span style={{ color: '#64748b' }}>Latency:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.latency} ms</span>
                          </>
                        )}
                        
                        {activeUplink.jitter != null && (
                          <>
                            <span style={{ color: '#64748b' }}>Jitter:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.jitter} ms</span>
                          </>
                        )}
                        
                        {activeUplink.connectionType && (
                          <>
                            <span style={{ color: '#64748b' }}>Tipo:</span>
                            <span style={{ fontWeight: 600, color: '#1e293b' }}>{activeUplink.connectionType}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
            
            {/* Graficas historicas del appliance - Connectivity y Client usage */}
            <Suspense fallback={<LoadingOverlay isLoading={true} message="Cargando gráficos históricos..." />}>
              <ApplianceHistoricalCharts 
                networkId={typeof selectedNetwork === 'object' ? selectedNetwork?.id : selectedNetwork}
              />
            </Suspense>
          </div>
        );
      }

      default:
        return <div>Selecciona una sección.</div>;
    }
  };

  return (
    <div style={{ width: '100vw', overflow: 'visible' }}>
  <TopBar onSearch={search} onLogout={onLogout} onSelectSection={setSection} sections={availableSections} selectedSection={section} selectedNetwork={selectedNetwork} />
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: 'auto minmax(0, 1fr)', 
        gap: 16, 
        padding: '16px', 
        alignItems: 'start', 
        background: '#f1f5f9', 
        minHeight: 'calc(100vh - 42px)',
        maxWidth: '100vw',
        boxSizing: 'border-box'
      }}>
        <div className="dashboard-sidebar">
          <Sidebar section={section} setSection={setSection} sections={availableSections} selectedNetwork={selectedNetwork} />
        </div>
        <main className="dashboard-container" style={{ 
          width: '100%', 
          maxWidth: '100%',
          overflow: 'visible',
          boxSizing: 'border-box'
        }}>
          {isMobile && (
            <div className="mobile-section-tiles-wrapper">
              <div className="mobile-section-tiles">
                {availableSections.map((item) => {
                  const IconComp = item.IconComponent || TopologyIcon;
                  // derive some counts for specific tiles
                  const total = mobileCounts[item.k] ?? 0;
                  let online = 0;
                  let offline = 0;
                  if (item.k === 'access_points') {
                    const aps = (enrichedAPs && enrichedAPs.length) ? enrichedAPs : (summaryData?.devices || []).filter(d => (d.model || '').toLowerCase().startsWith('mr'));
                    online = aps.filter(a => normalizeReachability(a.status) === 'connected').length;
                    offline = aps.filter(a => normalizeReachability(a.status) === 'disconnected').length;
                  } else if (item.k === 'switches') {
                    const sws = (summaryData?.devices || []).filter(d => (d.model || '').toLowerCase().startsWith('ms'));
                    online = sws.filter(s => normalizeReachability(s.status || s.statusNormalized || s.connectionStatus || 'unknown') === 'connected').length;
                    offline = sws.filter(s => normalizeReachability(s.status || s.statusNormalized || s.connectionStatus || 'unknown') === 'disconnected').length;
                  } else if (item.k === 'appliance_status') {
                    const apps = summaryData?.applianceStatus || [];
                    online = apps.filter(a => {
                      const uplinks = Array.isArray(a.uplinks) ? a.uplinks : [];
                      return uplinks.some(u => normalizeReachability(u.status || u.statusNormalized) === 'connected');
                    }).length;
                    offline = apps.length - online;
                  } else if (item.k === 'topology') {
                    online = mobileCounts.topology;
                    offline = 0;
                  }

                  return (
                    <div key={item.k} className="mobile-section-tile" role="button" onClick={() => setSection(item.k)} tabIndex={0}>
                      <div className="mobile-section-tile-row">
                        <div className="mobile-section-tile-icon"><IconComp /></div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', width: '100%' }}>
                          <div className="mobile-section-tile-title">{item.t}</div>
                          <div className="mobile-section-tile-count">{total} {total === 1 ? 'device' : 'devices'}</div>
                        </div>
                      </div>

                      {/* small summary row */}
                      <div style={{ display: 'flex', gap: 8, marginTop: 8, width: '100%', justifyContent: 'space-between' }}>
                        <div className="tile-stat">
                          <div className="tile-stat-value">{online}</div>
                          <div className="tile-stat-label">Online</div>
                        </div>
                        <div className="tile-stat">
                          <div className="tile-stat-value">{offline}</div>
                          <div className="tile-stat-label">Offline</div>
                        </div>
                        <div className="tile-stat">
                          <div className="tile-stat-value">{total ? total : '-'}</div>
                          <div className="tile-stat-label">{item.k === 'access_points' ? 'Total APs' : item.t}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {error && <div style={{ color: '#e74c3c', marginBottom: 10 }}>{error}</div>}
          
          <div style={{ 
            overflowX: section === 'topology' ? 'auto' : 'visible',
            overflowY: 'visible',
            width: '100%', 
            maxWidth: '100%',
            marginLeft: section === 'topology' ? '-40px' : '0',
            marginRight: section === 'topology' ? '-40px' : '0',
            paddingLeft: section === 'topology' ? '20px' : '0',
            paddingRight: section === 'topology' ? '20px' : '0'
          }}>
            {renderSection()}
          </div>
        </main>
      </div>
    </div>
  );
}

