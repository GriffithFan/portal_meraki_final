// Middleware de seguridad para el servidor
const helmet = require('helmet');
const jwt = require('jsonwebtoken');
const { rateLimit } = require('express-rate-limit');
const { logSecurity, logger } = require('../config/logger');

/**
 * Configuración de Helmet para headers de seguridad
 */
function configurarHelmet() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Desactivar si hay problemas con recursos externos
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true
    }
  });
}

/**
 * Rate limiter general para toda la API
 * Usa el IP detector automático de express-rate-limit (respeta trust proxy)
 */
const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 1000, // Límite de 1000 requests por ventana por IP
  message: {
    error: 'Demasiadas peticiones desde esta IP, por favor intente más tarde.',
    retryAfter: '15 minutos'
  },
  standardHeaders: true, // Retornar info de rate limit en headers `RateLimit-*`
  legacyHeaders: false, // Deshabilitar headers `X-RateLimit-*`
});

/**
 * Rate limiter estricto para endpoints de autenticación
 */
const limiterAuth = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // Solo 10 intentos de login por IP
  message: {
    error: 'Demasiados intentos de inicio de sesión, por favor intente más tarde.',
    retryAfter: '15 minutos'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // No contar requests exitosos
});

/**
 * Rate limiter para endpoints de datos intensivos (topología, dispositivos)
 */
const limiterDatos = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutos
  max: 100, // 100 requests por ventana
  message: {
    error: 'Demasiadas peticiones de datos, por favor intente más tarde.',
    retryAfter: '5 minutos'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Rate limiter para endpoints de escritura/modificación
 */
const limiterEscritura = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 50, // 50 operaciones de escritura por ventana
  message: {
    error: 'Demasiadas operaciones de escritura, por favor intente más tarde.',
    retryAfter: '15 minutos'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Middleware básico de protección CSRF para requests que modifican datos
 * Verifica que exista un header custom en requests POST/PUT/DELETE
 */
function proteccionCSRF(req, res, next) {
  // Solo aplicar a métodos que modifican datos
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    // Verificar header custom (debe ser enviado por el cliente)
    const csrfHeader = req.headers['x-requested-with'];
    if (!csrfHeader || csrfHeader !== 'XMLHttpRequest') {
      return res.status(403).json({
        error: 'Petición rechazada: falta header de seguridad requerido'
      });
    }
  }
  next();
}

/**
 * Middleware de sanitización básica de inputs
 * Elimina caracteres potencialmente peligrosos de query params y body
 */
function sanitizarInputs(req, res, next) {
  // Sanitizar query params
  if (req.query) {
    for (const key in req.query) {
      if (typeof req.query[key] === 'string') {
        // Eliminar caracteres potencialmente peligrosos
        req.query[key] = req.query[key]
          .replace(/<script[^>]*>.*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, '')
          .trim();
      }
    }
  }

  // Sanitizar body
  if (req.body && typeof req.body === 'object') {
    sanitizarObjeto(req.body);
  }

  next();
}

function sanitizarObjeto(obj) {
  for (const key in obj) {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key]
        .replace(/<script[^>]*>.*?<\/script>/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      sanitizarObjeto(obj[key]);
    }
  }
}

/**
 * Middleware para prevenir parameter pollution
 * Asegura que parámetros críticos no sean arrays
 */
function prevenirParameterPollution(req, res, next) {
  const parametrosCriticos = ['organizationId', 'networkId', 'deviceSerial', 'predio', 'usuario'];
  
  for (const param of parametrosCriticos) {
    if (req.query[param] && Array.isArray(req.query[param])) {
      // Tomar solo el primer valor
      req.query[param] = req.query[param][0];
    }
    if (req.body && req.body[param] && Array.isArray(req.body[param])) {
      req.body[param] = req.body[param][0];
    }
  }
  
  next();
}

/**
 * Middleware para validar formato de IDs comunes
 */
function validarFormatoIds(req, res, next) {
  const { organizationId, networkId } = req.query;
  
  // Validar organizationId si existe
  if (organizationId && !/^[a-zA-Z0-9_-]+$/.test(organizationId)) {
    return res.status(400).json({
      error: 'Formato inválido de organizationId'
    });
  }
  
  // Validar networkId si existe
  if (networkId && !/^[a-zA-Z0-9_-]+$/.test(networkId)) {
    return res.status(400).json({
      error: 'Formato inválido de networkId'
    });
  }
  
  next();
}

/**
 * Middleware para logging de requests sospechosos
 */
function logRequestsSospechosos(req, res, next) {
  const ip = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip;
  const patron = req.path.toLowerCase();
  
  // Patrones sospechosos
  const patronesSospechosos = [
    /\.\.\//,  // Path traversal
    /union.*select/i,  // SQL injection
    /javascript:/i,  // XSS
    /<script/i,  // XSS
    /eval\(/i,  // Code injection
    /\.env/i,  // Intento de acceso a .env
    /\/etc\//i,  // Acceso a archivos del sistema
  ];
  
  const esSospechoso = patronesSospechosos.some(p => p.test(patron) || p.test(JSON.stringify(req.query)));
  
  if (esSospechoso) {
    logSecurity('Request sospechoso detectado', {
      ip,
      path: req.path,
      query: req.query,
      userAgent: req.headers['user-agent']
    });
    // En producción, aquí podrías integrar con un sistema de alertas
  }
  
  next();
}

/**
 * Middleware para verificar JWT de técnicos
 * Verifica que el token sea válido y que el rol sea 'tecnico'
 */
function verificarTokenTecnico(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Token no proporcionado' 
    });
  }
  
  jwt.verify(token, process.env.JWT_SECRETO, (err, decoded) => {
    if (err) {
      logger.warn(`[security] Token inválido: ${err.message}`);
      return res.status(403).json({ 
        success: false, 
        message: 'Token inválido o expirado' 
      });
    }
    
    // Verificar que sea un técnico
    if (decoded.role !== 'tecnico') {
      return res.status(403).json({ 
        success: false, 
        message: 'Acceso no autorizado' 
      });
    }
    
    // Adjuntar datos del técnico al request
    req.tecnico = decoded;
    next();
  });
}

/**
 * Middleware para verificar JWT (cualquier usuario autenticado)
 * Más permisivo que verificarTokenTecnico
 */
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false, 
      message: 'Token no proporcionado' 
    });
  }
  
  jwt.verify(token, process.env.JWT_SECRETO, (err, decoded) => {
    if (err) {
      return res.status(403).json({ 
        success: false, 
        message: 'Token inválido o expirado' 
      });
    }
    
    req.usuario = decoded;
    next();
  });
}

module.exports = {
  configurarHelmet,
  limiterGeneral,
  limiterAuth,
  limiterDatos,
  limiterEscritura,
  proteccionCSRF,
  sanitizarInputs,
  prevenirParameterPollution,
  validarFormatoIds,
  logRequestsSospechosos,
  verificarTokenTecnico,
  verificarToken
};
