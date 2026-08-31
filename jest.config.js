module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'server.js',
    'db.js',
    'config.js',
    'ongkir-helper.js',
    '!node_modules/**',
    '!tests/**'
  ],
  testMatch: [
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.js'
  ],
  verbose: true,
  forceExit: true,
  clearMocks: true,
  resetModules: true,
};
