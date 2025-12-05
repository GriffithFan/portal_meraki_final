/**
 * Setup global para tests de Jest
 * Configura variables de entorno y mocks comunes
 */

// Variables de entorno para testing
process.env.NODE_ENV = 'test';
process.env.JWT_SECRETO = 'test-secret-key-for-testing';
process.env.ADMIN_KEY = 'test-admin-key';
process.env.MERAKI_API_KEY = 'test-meraki-api-key';
process.env.MERAKI_BASE_URL = 'https://api.meraki.com/api/v1';

// Silenciar logs en tests (opcional, comentar para debug)
jest.mock('../src/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  logAdmin: jest.fn(),
  logSecurity: jest.fn(),
  logError: jest.fn(),
  expressLogger: jest.fn((req, res, next) => next())
}));
