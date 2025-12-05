/**
 * Tests unitarios para usuario.js
 * Funciones de gestión de técnicos y autenticación
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// Mock del logger antes de importar el módulo
jest.mock('../src/config/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

// Configurar path temporal para tests
const TEST_TECNICOS_PATH = path.join(__dirname, 'test-tecnicos.json');

describe('usuario.js', () => {
  // Crear archivo temporal antes de cada test
  beforeEach(() => {
    // Crear usuarios de prueba
    const testUsers = [
      { username: 'test@example.com', password: bcrypt.hashSync('password123', 10) },
      { username: 'legacy@example.com', password: 'a'.repeat(64) } // Hash SHA-256 simulado
    ];
    fs.writeFileSync(TEST_TECNICOS_PATH, JSON.stringify(testUsers, null, 2));
  });

  // Limpiar después de cada test
  afterEach(() => {
    if (fs.existsSync(TEST_TECNICOS_PATH)) {
      fs.unlinkSync(TEST_TECNICOS_PATH);
    }
  });

  describe('isLegacyHash', () => {
    // Importar función después del mock
    const { isLegacyHash } = require('../src/usuario');

    test('debería detectar hash SHA-256 como legacy', () => {
      const sha256Hash = 'a'.repeat(64); // 64 caracteres hex
      expect(isLegacyHash(sha256Hash)).toBe(true);
    });

    test('debería detectar hash bcrypt como NO legacy', () => {
      const bcryptHash = '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/X4.F3M1Y2e3G4h5i6';
      expect(isLegacyHash(bcryptHash)).toBe(false);
    });

    test('debería retornar falsy para hash vacío', () => {
      expect(isLegacyHash('')).toBeFalsy();
      expect(isLegacyHash(null)).toBeFalsy();
      expect(isLegacyHash(undefined)).toBeFalsy();
    });

    test('debería retornar false para hash con caracteres no hex', () => {
      const invalidHash = 'g'.repeat(64); // 'g' no es hex
      expect(isLegacyHash(invalidHash)).toBe(false);
    });
  });

  describe('BCRYPT_ROUNDS', () => {
    const { BCRYPT_ROUNDS } = require('../src/usuario');

    test('debería tener al menos 10 rounds para seguridad', () => {
      expect(BCRYPT_ROUNDS).toBeGreaterThanOrEqual(10);
    });

    test('debería ser menor a 15 para rendimiento razonable', () => {
      expect(BCRYPT_ROUNDS).toBeLessThanOrEqual(15);
    });
  });
});

describe('Funciones de hash', () => {
  test('bcrypt.hash debería generar hash diferente al password original', async () => {
    const password = 'mySecurePassword123';
    const hash = await bcrypt.hash(password, 10);
    
    expect(hash).not.toBe(password);
    expect(hash.startsWith('$2b$') || hash.startsWith('$2a$')).toBe(true);
  });

  test('bcrypt.compare debería validar password correcto', async () => {
    const password = 'mySecurePassword123';
    const hash = await bcrypt.hash(password, 10);
    
    const isValid = await bcrypt.compare(password, hash);
    expect(isValid).toBe(true);
  });

  test('bcrypt.compare debería rechazar password incorrecto', async () => {
    const password = 'mySecurePassword123';
    const wrongPassword = 'wrongPassword';
    const hash = await bcrypt.hash(password, 10);
    
    const isValid = await bcrypt.compare(wrongPassword, hash);
    expect(isValid).toBe(false);
  });
});
