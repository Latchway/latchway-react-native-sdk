const {getDefaultConfig} = require('@react-native/metro-config');

// Standard Metro: no SDK source aliases, custom resolver or local watch folders.
module.exports = getDefaultConfig(__dirname);
