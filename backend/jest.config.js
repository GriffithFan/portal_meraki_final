/**
 * Configuración de Jest para el backend
 */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/servidor.js', // Excluir punto de entrada
    '!src/warmCache.js' // Excluir procesos de caché
  ],
  coverageDirectory: 'coverage',
  verbose: true,
  testTimeout: 10000,
  // Ignorar node_modules
  modulePathIgnorePatterns: ['<rootDir>/node_modules/'],
  // Setup para variables de entorno de test
  setupFiles: ['<rootDir>/__tests__/setup.js']
};
