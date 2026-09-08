const path = require('node:path');
module.exports = process.env.LATCHWAY_SHARED_NATIVE_SOURCE === '1' ? {
  dependencies: {'@latchway/react-native': {root: path.join(__dirname, '.latchway-development')}},
} : {};
