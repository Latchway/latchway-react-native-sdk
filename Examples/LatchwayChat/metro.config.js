const {getDefaultConfig} = require('@react-native/metro-config');
const path = require('node:path');

const config = getDefaultConfig(__dirname);
if (process.env.LATCHWAY_SHARED_NATIVE_SOURCE === '1') {
  const sdk = path.resolve(__dirname, '../..');
  config.watchFolders = [sdk];
  config.resolver.nodeModulesPaths = [path.join(__dirname, 'node_modules')];
  config.resolver.resolveRequest = (context, name, platform) => {
    if (name === '@latchway/react-native') return {type: 'sourceFile', filePath: path.join(sdk, 'lib/index.js')};
    // Resolve the source-linked library's peers through the host. Keep normal
    // hierarchical resolution inside host dependencies (including nested RN deps).
    if (context.originModulePath.startsWith(path.join(sdk, 'lib') + path.sep) && !name.startsWith('.') && !path.isAbsolute(name)) {
      return context.resolveRequest({...context, originModulePath: path.join(__dirname, 'index.js')}, name, platform);
    }
    return context.resolveRequest(context, name, platform);
  };
}
module.exports = config;
