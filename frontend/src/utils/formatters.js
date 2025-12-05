/**
 * Utilidades de formateo para el Dashboard y componentes
 * 
 * @module utils/formatters
 */

/**
 * Formatea un valor métrico agregando la unidad apropiada
 * @param {*} value - Valor a formatear
 * @returns {string} Valor formateado
 */
export const formatMetric = (value) => {
  if (value == null || value === '') return '-';
  if (typeof value === 'string') return value;
  return String(value);
};

/**
 * Formatea una fecha/hora en formato local
 * @param {string|Date|number} value - Valor a formatear
 * @param {Object} options - Opciones de formato
 * @returns {string} Fecha/hora formateada
 */
export const formatDateTime = (value, { timeZone = 'America/Argentina/Buenos_Aires' } = {}) => {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('es-AR', { timeZone });
  } catch {
    return String(value);
  }
};

/**
 * Formatea una lista de valores separados por coma
 * @param {Array|string} value - Valor a formatear
 * @param {string} separator - Separador (default: ', ')
 * @returns {string} Lista formateada
 */
export const formatList = (value, separator = ', ') => {
  if (Array.isArray(value)) return value.join(separator);
  if (typeof value === 'string') return value;
  return String(value || '-');
};

/**
 * Formatea una duración en segundos a formato legible
 * @param {number} seconds - Duración en segundos
 * @returns {string} Duración formateada (ej: "2h 30m")
 */
export const formatDuration = (seconds) => {
  const total = Number(seconds);
  if (!Number.isFinite(total) || total <= 0) return '0s';
  
  const parts = [];
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  
  return parts.slice(0, 2).join(' ');
};

/**
 * Formatea un valor en Kbps a formato legible
 * @param {number} value - Valor en Kbps
 * @returns {string} Valor formateado con unidad apropiada
 */
export const formatKbpsValue = (value) => {
  if (value == null || value === '') return '-';
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return '-';
  
  if (Math.abs(num) >= 1024) return `${(num / 1024).toFixed(1)} Mbps`;
  if (Math.abs(num) >= 1) return `${num.toFixed(0)} Kbps`;
  return `${(num * 1000).toFixed(0)} bps`;
};

/**
 * Formatea bytes a unidad legible
 * @param {number} bytes - Valor en bytes
 * @returns {string} Valor formateado
 */
export const formatBytes = (bytes) => {
  if (bytes == null || !Number.isFinite(bytes)) return '-';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Math.abs(bytes);
  let unitIndex = 0;
  
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  
  return `${value.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
};

/**
 * Resume el uso de un puerto (recv/sent)
 * @param {Object} port - Objeto de puerto
 * @returns {Object|string} Uso resumido
 */
export const summarizeUsage = (port) => {
  if (!port) return '-';
  
  // Formato simple: usageKbps
  if (port.usageKbps != null) {
    return formatKbpsValue(port.usageKbps);
  }
  
  // Formato split: down/up
  const down = port.usageSplitKbps?.down;
  const up = port.usageSplitKbps?.up;
  if (down != null || up != null) {
    const downLabel = down != null ? formatKbpsValue(down) : '-';
    const upLabel = up != null ? formatKbpsValue(up) : '-';
    return `${downLabel} ↓ / ${upLabel} ↑`;
  }
  
  // Formato legacy: usageInKb
  if (port.usageInKb) {
    const recv = port.usageInKb.recv != null ? formatKbpsValue(port.usageInKb.recv) : '-';
    const sent = port.usageInKb.sent != null ? formatKbpsValue(port.usageInKb.sent) : '-';
    return { recv, sent };
  }
  
  return '-';
};

/**
 * Obtiene el alias de un puerto
 * @param {Object} port - Objeto de puerto
 * @returns {string} Alias del puerto
 */
export const getPortAlias = (port) => {
  if (!port) return '-';
  
  // Prioridad: uplink interface > name > role-based > number
  if (port.uplink?.interface) return port.uplink.interface.toUpperCase();
  if (port.alias) return port.alias;
  if (port.name && !looksLikeSerial(port.name)) return port.name;
  if (port.role === 'wan') return `WAN ${port.number || port.portId || '?'}`;
  
  return `Puerto ${port.number || port.portId || '?'}`;
};

/**
 * Obtiene la etiqueta de estado de un puerto
 * @param {Object} port - Objeto de puerto
 * @returns {string} Etiqueta de estado
 */
export const getPortStatusLabel = (port) => {
  if (!port) return 'Unknown';
  if (port.enabled === false) return 'disabled';
  return port.statusNormalized || port.status || 'Unknown';
};

/**
 * Formatea la etiqueta de velocidad de un puerto
 * @param {Object} port - Objeto de puerto
 * @returns {string} Velocidad formateada
 */
export const formatSpeedLabel = (port) => {
  if (!port) return '-';
  if (port.speedLabel) return port.speedLabel;
  if (port.speed) return port.speed;
  if (port.speedMbps != null) return `${port.speedMbps} Mbps`;
  if (port.wiredSpeed) return formatWiredSpeed(port.wiredSpeed);
  return '-';
};

/**
 * Formatea la velocidad cableada (Ethernet) al formato Meraki
 * @param {string} speedString - String de velocidad
 * @returns {string} Velocidad formateada
 */
export const formatWiredSpeed = (speedString) => {
  if (!speedString || speedString === '-' || speedString === 'null') return '-';
  
  const str = String(speedString).toLowerCase();
  
  // Si ya viene en formato Meraki correcto, retornar tal cual
  if (str.includes('mbit') || str.includes('mbps')) {
    return speedString;
  }
  
  let mbits = 0;
  let duplex = '';
  
  // Detectar duplex
  if (str.includes('full')) {
    duplex = ', full duplex';
  } else if (str.includes('half')) {
    duplex = ', half duplex';
  } else {
    duplex = ', full duplex'; // Default
  }
  
  // Extraer velocidad
  if (str.includes('gbps') || str.includes('gb/s') || str.includes('gbit')) {
    const match = speedString.match(/(\d+(?:\.\d+)?)/);
    if (match) mbits = parseFloat(match[1]) * 1000;
  } else if (str.includes('mbps') || str.includes('mb/s') || str.includes('mbit')) {
    const match = speedString.match(/(\d+(?:\.\d+)?)/);
    if (match) mbits = parseFloat(match[1]);
  } else if (str.includes('kbps') || str.includes('kb/s') || str.includes('kbit')) {
    const match = speedString.match(/(\d+(?:\.\d+)?)/);
    if (match) mbits = parseFloat(match[1]) / 1000;
  } else {
    // Si es solo un número, asumir Mbps
    const match = speedString.match(/(\d+(?:\.\d+)?)/);
    if (match) {
      mbits = parseFloat(match[1]);
    }
  }
  
  if (mbits > 0) {
    return `${Math.round(mbits)} Mbit${duplex}`;
  }
  
  return speedString;
};

/**
 * Formatea un score de calidad (0-100)
 * @param {number} value - Score de calidad
 * @returns {string} Score formateado
 */
export const formatQualityScore = (value) => {
  if (value == null) return '-';
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return '-';
  return `${Math.round(num)} pts`;
};

/**
 * Formatea un porcentaje de cobertura
 * @param {number} value - Valor de cobertura
 * @returns {string} Cobertura formateada
 */
export const formatCoverage = (value) => {
  if (value == null) return '-';
  const num = parseFloat(value);
  if (!Number.isFinite(num) || num < 0) return '-';
  
  // Si es <= 1, asumir que es fracción
  if (num <= 1) return `${Math.round(num * 100)}%`;
  // Si es > 100, limitarlo
  return `${Math.round(Math.min(num, 100))}%`;
};

/**
 * Formatea un porcentaje genérico
 * @param {number} value - Valor a formatear
 * @param {number} decimals - Decimales a mostrar
 * @returns {string} Porcentaje formateado
 */
export const formatPercent = (value, decimals = 1) => {
  if (value == null) return '-';
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return '-';
  return `${num.toFixed(decimals)}%`;
};

/**
 * Formatea latencia en milisegundos
 * @param {number} value - Latencia en ms
 * @returns {string} Latencia formateada
 */
export const formatLatency = (value) => {
  if (value == null) return '-';
  const num = parseFloat(value);
  if (!Number.isFinite(num)) return '-';
  
  if (num >= 1000) return `${(num / 1000).toFixed(2)}s`;
  return `${num.toFixed(0)}ms`;
};

/**
 * Verifica si un valor parece un número de serie de Meraki
 * @param {string} value - Valor a verificar
 * @returns {boolean} true si parece un serial
 */
export const looksLikeSerial = (value) => {
  if (!value) return false;
  const str = String(value).toUpperCase();
  // Los seriales de Meraki suelen tener formato: QXXX-XXXX-XXXX o XXXX-XXXX-XXXX
  return /^Q[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(str) || 
         /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(str);
};

/**
 * Trunca un string a una longitud máxima con ellipsis
 * @param {string} str - String a truncar
 * @param {number} maxLength - Longitud máxima
 * @returns {string} String truncado
 */
export const truncate = (str, maxLength = 50) => {
  if (!str) return '';
  if (str.length <= maxLength) return str;
  return `${str.substring(0, maxLength - 3)}...`;
};

/**
 * Capitaliza la primera letra de un string
 * @param {string} str - String a capitalizar
 * @returns {string} String capitalizado
 */
export const capitalize = (str) => {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
};

/**
 * Formatea un número con separador de miles
 * @param {number} value - Número a formatear
 * @returns {string} Número formateado
 */
export const formatNumber = (value) => {
  if (value == null) return '-';
  const num = Number(value);
  if (!Number.isFinite(num)) return '-';
  return num.toLocaleString('es-AR');
};
