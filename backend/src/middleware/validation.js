/**
 * Middleware de validación con express-validator
 * Centraliza validaciones para todos los endpoints
 */
const { body, param, query, validationResult } = require('express-validator');

/**
 * Middleware que procesa los errores de validación
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Errores de validación',
      details: errors.array().map(err => ({
        field: err.path,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
};

// ============================================
// VALIDACIONES DE AUTENTICACIÓN
// ============================================

const validateLogin = [
  body('username')
    .trim()
    .notEmpty().withMessage('Usuario requerido')
    .isLength({ min: 3, max: 50 }).withMessage('Usuario debe tener entre 3 y 50 caracteres')
    .matches(/^[a-zA-Z0-9_.\-@]+$/).withMessage('Usuario solo puede contener letras, números, guiones, puntos y @'),
  body('password')
    .notEmpty().withMessage('Contraseña requerida')
    .isLength({ min: 4, max: 100 }).withMessage('Contraseña debe tener entre 4 y 100 caracteres'),
  handleValidationErrors
];

const validateAdminLogin = [
  body('key')
    .notEmpty().withMessage('Clave administrativa requerida')
    .isLength({ min: 8 }).withMessage('Clave debe tener al menos 8 caracteres'),
  handleValidationErrors
];

const validateCreateTecnico = [
  body('username')
    .trim()
    .notEmpty().withMessage('Usuario requerido')
    .isLength({ min: 3, max: 50 }).withMessage('Usuario debe tener entre 3 y 50 caracteres')
    .matches(/^[a-zA-Z0-9_.\-@]+$/).withMessage('Usuario solo puede contener letras, números, guiones, puntos y @'),
  body('password')
    .notEmpty().withMessage('Contraseña requerida')
    .isLength({ min: 6 }).withMessage('Contraseña debe tener al menos 6 caracteres'),
  body('nombre')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Nombre no puede exceder 100 caracteres'),
  body('email')
    .optional()
    .trim()
    .isEmail().withMessage('Email inválido'),
  handleValidationErrors
];

// ============================================
// VALIDACIONES DE REDES Y DISPOSITIVOS
// ============================================

const validateNetworkId = [
  param('networkId')
    .trim()
    .notEmpty().withMessage('Network ID requerido')
    .matches(/^[LN]_[a-zA-Z0-9]+$/).withMessage('Formato de Network ID inválido (debe ser L_xxx o N_xxx)'),
  handleValidationErrors
];

const validateOrganizationId = [
  param('orgId')
    .trim()
    .notEmpty().withMessage('Organization ID requerido')
    .isNumeric().withMessage('Organization ID debe ser numérico'),
  handleValidationErrors
];

const validateDeviceSerial = [
  param('serial')
    .trim()
    .notEmpty().withMessage('Serial requerido')
    .matches(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/).withMessage('Formato de serial inválido (debe ser XXXX-XXXX-XXXX)'),
  handleValidationErrors
];

// ============================================
// VALIDACIONES DE BÚSQUEDA
// ============================================

const validateSearch = [
  query('q')
    .trim()
    .notEmpty().withMessage('Término de búsqueda requerido')
    .isLength({ min: 2, max: 200 }).withMessage('Búsqueda debe tener entre 2 y 200 caracteres')
    .escape(), // Sanitiza caracteres HTML
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 }).withMessage('Límite debe ser un número entre 1 y 100'),
  handleValidationErrors
];

const validatePredioCode = [
  param('predioCode')
    .trim()
    .notEmpty().withMessage('Código de predio requerido')
    .isLength({ min: 3, max: 50 }).withMessage('Código debe tener entre 3 y 50 caracteres'),
  handleValidationErrors
];

// ============================================
// VALIDACIONES DE TIMESPAN
// ============================================

const validateTimespan = [
  query('timespan')
    .optional()
    .isInt({ min: 60, max: 2592000 }).withMessage('Timespan debe ser entre 60 y 2592000 segundos'),
  query('resolution')
    .optional()
    .isIn(['60', '600', '3600', '86400']).withMessage('Resolution debe ser 60, 600, 3600 o 86400'),
  handleValidationErrors
];

// ============================================
// VALIDACIONES DE CONFIGURACIÓN DE PUERTOS
// ============================================

const validatePortConfig = [
  param('serial')
    .trim()
    .notEmpty().withMessage('Serial requerido'),
  param('portId')
    .trim()
    .notEmpty().withMessage('Port ID requerido'),
  body('enabled')
    .optional()
    .isBoolean().withMessage('enabled debe ser booleano'),
  body('vlan')
    .optional()
    .isInt({ min: 1, max: 4094 }).withMessage('VLAN debe ser entre 1 y 4094'),
  body('name')
    .optional()
    .trim()
    .isLength({ max: 100 }).withMessage('Nombre no puede exceder 100 caracteres'),
  handleValidationErrors
];

// ============================================
// VALIDACIÓN GENÉRICA DE IDs
// ============================================

const validateMerakiIds = [
  query('organizationId')
    .optional()
    .matches(/^[0-9]+$/).withMessage('organizationId debe ser numérico'),
  query('networkId')
    .optional()
    .matches(/^[LN]_[a-zA-Z0-9]+$/).withMessage('networkId inválido'),
  handleValidationErrors
];

// ============================================
// EXPORTS
// ============================================

module.exports = {
  // Middleware base
  handleValidationErrors,
  
  // Autenticación
  validateLogin,
  validateAdminLogin,
  validateCreateTecnico,
  
  // Redes y dispositivos
  validateNetworkId,
  validateOrganizationId,
  validateDeviceSerial,
  
  // Búsqueda
  validateSearch,
  validatePredioCode,
  
  // Configuración
  validateTimespan,
  validatePortConfig,
  validateMerakiIds,
  
  // Re-export de express-validator para uso directo
  body,
  param,
  query,
  validationResult
};
