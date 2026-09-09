/** @type {import('ts-jest').JestConfigWithTsJest} */
import baseConfig from './jest.config.js';

export default {
  ...baseConfig,
  testMatch: ['**/tests/soak/**/*.soak.test.ts'],
  testPathIgnorePatterns: ['/node_modules/']
};
