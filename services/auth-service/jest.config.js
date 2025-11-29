module.exports = {
  displayName: 'Auth-Service',
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: [
    'src/routes/**/*.js'       
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'lcov'],
};
