module.exports = {
  displayName: 'Event-Service',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  collectCoverageFrom: ['src/routes/**/*.js', '!src/**/__tests__/**'],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    'src/server.js',
    'src/models/'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
  verbose: true,
  transform: {}
};
