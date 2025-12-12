// Configuración de Winston Logger para el Portal Meraki
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Niveles de log personalizados
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Colores para la consola
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Determinar nivel de log según entorno
const level = () => {
  const env = process.env.NODE_ENV || 'development';
  const isDevelopment = env === 'development';
  return isDevelopment ? 'debug' : 'info';
};

// Formato para desarrollo (colorizado y legible)
const devFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info;
    let metaStr = '';
    
    // Agregar metadata si existe
    if (Object.keys(meta).length > 0) {
      metaStr = '\n' + JSON.stringify(meta, null, 2);
    }
    
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Formato para producción (JSON estructurado)
const prodFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Formato para archivos de log
const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Directorio de logs
const logsDir = path.join(__dirname, '../../logs');

// Crear directorio de logs si no existe
const fs = require('fs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Transport para todos los logs (rotación diaria)
const allLogsTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'application-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m', // 20MB por archivo
  maxFiles: '30d', // Mantener 30 días
  format: fileFormat,
  level: 'debug',
});

// Transport para errores (rotación diaria)
const errorLogsTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '90d', // Mantener errores por 90 días
  format: fileFormat,
  level: 'error',
});

// Transport para requests HTTP (rotación diaria)
const httpLogsTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'http-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m', // HTTP logs pueden ser más grandes
  maxFiles: '14d', // 2 semanas
  format: fileFormat,
  level: 'http',
});

// Transport para auditoría de seguridad
const securityLogsTransport = new DailyRotateFile({
  filename: path.join(logsDir, 'security-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '180d', // Mantener logs de seguridad por 6 meses
  format: fileFormat,
  level: 'warn', // Solo warnings y errores de seguridad
});

// Transport para la consola
const consoleTransport = new winston.transports.Console({
  format: process.env.NODE_ENV === 'production' ? prodFormat : devFormat,
});

// Crear el logger principal
const logger = winston.createLogger({
  level: level(),
  levels,
  transports: [
    consoleTransport,
    allLogsTransport,
    errorLogsTransport,
    httpLogsTransport,
  ],
  // Manejar excepciones no capturadas
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '90d',
      format: fileFormat,
    }),
  ],
  // Manejar rechazos de promesas no capturadas
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logsDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '90d',
      format: fileFormat,
    }),
  ],
  // No salir del proceso en error
  exitOnError: false,
});

// Logger especializado para seguridad
const securityLogger = winston.createLogger({
  level: 'warn',
  levels,
  format: fileFormat,
  transports: [
    securityLogsTransport,
    consoleTransport,
  ],
  exitOnError: false,
});

// Funciones helper para logging estructurado

/**
 * Log de request HTTP
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {number} duration - Duración del request en ms
 */
function logRequest(req, res, duration) {
  const logData = {
    method: req.method,
    url: req.originalUrl || req.url,
    statusCode: res.statusCode,
    duration: `${duration}ms`,
    ip: req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip,
    userAgent: req.headers['user-agent'],
    referer: req.headers['referer'],
  };

  // Incluir usuario si está autenticado
  if (req.user) {
    logData.user = req.user.username || req.user.id;
  }

  // Nivel según status code
  if (res.statusCode >= 500) {
    logger.error('HTTP Request Error', logData);
  } else if (res.statusCode >= 400) {
    logger.warn('HTTP Request Warning', logData);
  } else {
    logger.http('HTTP Request', logData);
  }
}

/**
 * Log de evento de seguridad
 * @param {string} event - Tipo de evento
 * @param {Object} details - Detalles del evento
 */
function logSecurity(event, details = {}) {
  securityLogger.warn(`[SECURITY] ${event}`, {
    event,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Log de error con context adicional
 * @param {string} message - Mensaje del error
 * @param {Error} error - Objeto de error
 * @param {Object} context - Context adicional
 */
function logError(message, error, context = {}) {
  logger.error(message, {
    error: {
      message: error.message,
      stack: error.stack,
      name: error.name,
      code: error.code,
    },
    ...context,
  });
}

/**
 * Log de operación administrativa
 * @param {string} action - Acción realizada
 * @param {Object} details - Detalles de la operación
 */
function logAdmin(action, details = {}) {
  logger.info(`[ADMIN] ${action}`, {
    action,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

/**
 * Log de operación en caché
 * @param {string} operation - Tipo de operación (hit, miss, set, clear)
 * @param {Object} details - Detalles
 */
function logCache(operation, details = {}) {
  logger.debug(`[CACHE] ${operation}`, {
    operation,
    ...details,
  });
}

/**
 * Log de integración con API externa (Meraki)
 * @param {string} endpoint - Endpoint llamado
 * @param {Object} details - Detalles de la llamada
 */
function logAPICall(endpoint, details = {}) {
  logger.debug(`[API] ${endpoint}`, {
    endpoint,
    ...details,
  });
}

// Middleware de Express para logging automático de requests
function expressLogger() {
  return (req, res, next) => {
    const startTime = Date.now();

    // Hook en el evento finish de la respuesta
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logRequest(req, res, duration);
    });

    next();
  };
}

module.exports = {
  logger,
  securityLogger,
  logRequest,
  logSecurity,
  logError,
  logAdmin,
  logCache,
  logAPICall,
  expressLogger,
};
