/**
 * Configuración centralizada de variables de entorno
 * Carga dotenv y valida variables requeridas
 */
const path = require('path');

// Cargar dotenv desde la raíz del backend
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/**
 * Obtiene una variable de entorno con valor por defecto
 * @param {string} key - Nombre de la variable
 * @param {*} defaultValue - Valor por defecto
 * @returns {string}
 */
const get = (key, defaultValue = '') => process.env[key] || defaultValue;

/**
 * Obtiene una variable de entorno como número
 * @param {string} key - Nombre de la variable
 * @param {number} defaultValue - Valor por defecto
 * @returns {number}
 */
const getNumber = (key, defaultValue = 0) => {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  const parsed = Number(value);
  return isNaN(parsed) ? defaultValue : parsed;
};

/**
 * Obtiene una variable de entorno como booleano
 * @param {string} key - Nombre de la variable
 * @param {boolean} defaultValue - Valor por defecto
 * @returns {boolean}
 */
const getBoolean = (key, defaultValue = false) => {
  const value = process.env[key];
  if (value === undefined || value === '') return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
};

/**
 * Obtiene una variable de entorno requerida
 * @param {string} key - Nombre de la variable
 * @throws {Error} Si la variable no está definida
 * @returns {string}
 */
const getRequired = (key) => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Variable de entorno requerida no definida: ${key}`);
  }
  return value;
};

// ============================================
// CONFIGURACIÓN DEL SERVIDOR
// ============================================
const server = {
  nodeEnv: get('NODE_ENV', 'development'),
  port: getNumber('PORT', getNumber('PUERTO', 3000)), // PORT (Railway) o PUERTO (legacy)
  host: get('HOST', '0.0.0.0'),
  trustProxyHops: getNumber('TRUST_PROXY_HOPS', 1),
  isProduction: get('NODE_ENV') === 'production',
  isDevelopment: get('NODE_ENV') !== 'production',
};

// ============================================
// CONFIGURACIÓN DE MERAKI API
// ============================================
const meraki = {
  apiKey: get('MERAKI_API_KEY'),
  orgId: get('MERAKI_ORG_ID'),
  orgIds: get('MERAKI_ORG_IDS'),
  baseUrl: get('MERAKI_BASE_URL', 'https://api.meraki.com/api/v1'),
  hasApiKey: !!get('MERAKI_API_KEY'),
  hasOrgId: !!get('MERAKI_ORG_ID'),
};

// ============================================
// CONFIGURACIÓN DE SEGURIDAD
// ============================================
const security = {
  jwtSecretKey: get('JWT_SECRETO'),
  adminKey: get('ADMIN_KEY'),
  secondAdminKey: get('SECOND_ADMIN_KEY'),
  hasJwtSecret: !!get('JWT_SECRETO'),
  hasAdminKey: !!get('ADMIN_KEY'),
};

// ============================================
// CONFIGURACIÓN DE CORS
// ============================================
const cors = {
  origins: get('CORS_ORIGINS', 'http://localhost:5173'),
  originsArray: get('CORS_ORIGINS', 'http://localhost:5173').split(',').map(s => s.trim()),
  allowAll: get('CORS_ORIGINS') === '*',
};

// ============================================
// CONFIGURACIÓN DE CACHÉ
// ============================================
const cache = {
  enableWarmCache: getBoolean('ENABLE_WARM_CACHE', true),
  warmCacheSize: getNumber('WARM_CACHE_SIZE', 20),
  lldpCacheTtlMs: getNumber('LLDP_CACHE_TTL_MS', 600000),
};

// ============================================
// CONFIGURACIÓN DE PREDIOS
// ============================================
const predios = {
  refreshIntervalMinutes: getNumber('PREDIOS_REFRESH_INTERVAL_MINUTES', 30),
  refreshInitialDelayMs: getNumber('PREDIOS_REFRESH_INITIAL_DELAY_MS', 30000),
};

// ============================================
// VALIDACIÓN DE CONFIGURACIÓN
// ============================================

/**
 * Valida que las variables requeridas estén configuradas
 * @param {boolean} throwOnError - Si lanza excepción o solo retorna warnings
 * @returns {{ valid: boolean, warnings: string[], errors: string[] }}
 */
const validate = (throwOnError = false) => {
  const warnings = [];
  const errors = [];

  // Validaciones críticas
  if (!meraki.apiKey) {
    errors.push('MERAKI_API_KEY no está definida - la API no funcionará');
  }

  // Validaciones de seguridad
  if (!security.jwtSecretKey) {
    warnings.push('JWT_SECRETO no definido - autenticación de técnicos no funcionará');
  } else if (security.jwtSecretKey.length < 32) {
    warnings.push('JWT_SECRETO debe tener al menos 32 caracteres para ser seguro');
  }

  if (!security.adminKey) {
    warnings.push('ADMIN_KEY no definida - endpoints administrativos no estarán protegidos');
  }

  // Validaciones de producción
  if (server.isProduction) {
    if (cors.allowAll) {
      warnings.push('CORS_ORIGINS="*" no es seguro en producción');
    }
    if (!security.adminKey) {
      errors.push('ADMIN_KEY es requerida en producción');
    }
  }

  const valid = errors.length === 0;

  if (throwOnError && !valid) {
    throw new Error(`Errores de configuración:\n${errors.join('\n')}`);
  }

  return { valid, warnings, errors };
};

/**
 * Obtiene un resumen de la configuración (sin datos sensibles)
 * @returns {Object}
 */
const getSummary = () => ({
  nodeEnv: server.nodeEnv,
  port: server.port,
  hasApiKey: meraki.hasApiKey,
  hasOrgId: meraki.hasOrgId,
  hasJwtSecret: security.hasJwtSecret,
  hasAdminKey: security.hasAdminKey,
  warmCacheEnabled: cache.enableWarmCache,
  warmCacheSize: cache.warmCacheSize,
});

// ============================================
// EXPORTS
// ============================================
module.exports = {
  // Helpers
  get,
  getNumber,
  getBoolean,
  getRequired,
  
  // Configuración por categoría
  server,
  meraki,
  security,
  cors,
  cache,
  predios,
  
  // Utilidades
  validate,
  getSummary,
  
  // Acceso directo a valores más usados
  NODE_ENV: server.nodeEnv,
  PORT: server.port,
  HOST: server.host,
  MERAKI_API_KEY: meraki.apiKey,
  MERAKI_ORG_ID: meraki.orgId,
  JWT_SECRETO: security.jwtSecretKey,
  ADMIN_KEY: security.adminKey,
  IS_PRODUCTION: server.isProduction,
  IS_DEVELOPMENT: server.isDevelopment,
};
