module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['./scripts/jest-setup.cjs'],
  moduleNameMapper: {
    '^@latchway/client$': '<rootDir>/node_modules/@latchway/client/dist/index.js',
  },
  transformIgnorePatterns: [
    'node_modules/(?!((@)?react-native|@react-native(-community)?)/|@latchway/client/)',
  ],
};
