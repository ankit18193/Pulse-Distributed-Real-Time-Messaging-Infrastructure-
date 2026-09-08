/** @type {import('ts-jest').JestConfigWithTsJest} */
const baseConfig = require('./jest.config.js');

module.exports = {
  ...baseConfig,
  testMatch: ['**/tests/soak/**/*.soak.test.ts'],
  testPathIgnorePatterns: ['/node_modules/']
};
