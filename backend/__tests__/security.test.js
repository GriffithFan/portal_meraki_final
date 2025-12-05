/**
 * Tests unitarios para middleware/security.js
 * Funciones de seguridad y validación
 */

// Mock del logger
jest.mock('../src/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  },
  logSecurity: jest.fn()
}));

// Mock de express-rate-limit para evitar errores
jest.mock('express-rate-limit', () => ({
  rateLimit: jest.fn(() => (req, res, next) => next())
}));

describe('security.js middlewares', () => {
  let mockReq;
  let mockRes;
  let mockNext;

  beforeEach(() => {
    mockReq = {
      method: 'GET',
      headers: {},
      query: {},
      body: {},
      path: '/api/test',
      ip: '127.0.0.1'
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn()
    };
    mockNext = jest.fn();
  });

  describe('sanitizarInputs', () => {
    const { sanitizarInputs } = require('../src/middleware/security');

    test('debería eliminar tags de script de query params', () => {
      mockReq.query = {
        search: '<script>alert("xss")</script>Hello'
      };

      sanitizarInputs(mockReq, mockRes, mockNext);

      expect(mockReq.query.search).toBe('Hello');
      expect(mockNext).toHaveBeenCalled();
    });

    test('debería eliminar tags HTML del body', () => {
      mockReq.body = {
        nombre: '<b>Bold</b> text',
        descripcion: '<div>Content</div>'
      };

      sanitizarInputs(mockReq, mockRes, mockNext);

      expect(mockReq.body.nombre).toBe('Bold text');
      expect(mockReq.body.descripcion).toBe('Content');
    });

    test('debería mantener strings sin HTML sin cambios', () => {
      mockReq.query = { search: 'normal search text' };

      sanitizarInputs(mockReq, mockRes, mockNext);

      expect(mockReq.query.search).toBe('normal search text');
    });

    test('debería llamar next() siempre', () => {
      sanitizarInputs(mockReq, mockRes, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);
    });
  });

  describe('prevenirParameterPollution', () => {
    const { prevenirParameterPollution } = require('../src/middleware/security');

    test('debería tomar solo el primer valor si organizationId es array', () => {
      mockReq.query = {
        organizationId: ['org1', 'org2', 'org3']
      };

      prevenirParameterPollution(mockReq, mockRes, mockNext);

      expect(mockReq.query.organizationId).toBe('org1');
      expect(mockNext).toHaveBeenCalled();
    });

    test('debería mantener valor string sin cambios', () => {
      mockReq.query = {
        networkId: 'network123'
      };

      prevenirParameterPollution(mockReq, mockRes, mockNext);

      expect(mockReq.query.networkId).toBe('network123');
    });

    test('debería procesar body también', () => {
      mockReq.body = {
        predio: ['predio1', 'predio2']
      };

      prevenirParameterPollution(mockReq, mockRes, mockNext);

      expect(mockReq.body.predio).toBe('predio1');
    });
  });

  describe('validarFormatoIds', () => {
    const { validarFormatoIds } = require('../src/middleware/security');

    test('debería aceptar organizationId válido', () => {
      mockReq.query = { organizationId: 'org_123-abc' };

      validarFormatoIds(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    test('debería rechazar organizationId con caracteres inválidos', () => {
      mockReq.query = { organizationId: 'org<script>' };

      validarFormatoIds(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({
        error: 'Formato inválido de organizationId'
      });
    });

    test('debería rechazar networkId con espacios', () => {
      mockReq.query = { networkId: 'network 123' };

      validarFormatoIds(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    test('debería aceptar cuando no hay IDs', () => {
      mockReq.query = {};

      validarFormatoIds(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('proteccionCSRF', () => {
    const { proteccionCSRF } = require('../src/middleware/security');

    test('debería permitir GET requests sin header', () => {
      mockReq.method = 'GET';

      proteccionCSRF(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    test('debería rechazar POST sin header X-Requested-With', () => {
      mockReq.method = 'POST';

      proteccionCSRF(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('debería aceptar POST con header correcto', () => {
      mockReq.method = 'POST';
      mockReq.headers['x-requested-with'] = 'XMLHttpRequest';

      proteccionCSRF(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    test('debería rechazar DELETE sin header', () => {
      mockReq.method = 'DELETE';

      proteccionCSRF(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });
  });

  describe('verificarTokenTecnico', () => {
    const jwt = require('jsonwebtoken');
    const { verificarTokenTecnico } = require('../src/middleware/security');

    test('debería rechazar request sin token', () => {
      verificarTokenTecnico(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(401);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Token no proporcionado'
      });
    });

    test('debería rechazar token inválido', () => {
      mockReq.headers['authorization'] = 'Bearer invalid-token';

      verificarTokenTecnico(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    test('debería aceptar token válido con rol técnico', () => {
      const token = jwt.sign(
        { username: 'test@example.com', role: 'tecnico' },
        process.env.JWT_SECRETO || 'test-secret',
        { expiresIn: '1h' }
      );
      mockReq.headers['authorization'] = `Bearer ${token}`;

      verificarTokenTecnico(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockReq.tecnico).toBeDefined();
      expect(mockReq.tecnico.username).toBe('test@example.com');
    });

    test('debería rechazar token con rol incorrecto', () => {
      const token = jwt.sign(
        { username: 'admin@example.com', role: 'admin' },
        process.env.JWT_SECRETO || 'test-secret',
        { expiresIn: '1h' }
      );
      mockReq.headers['authorization'] = `Bearer ${token}`;

      verificarTokenTecnico(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        message: 'Acceso no autorizado'
      });
    });
  });
});
