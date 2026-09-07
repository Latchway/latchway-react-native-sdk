import React from 'react';
import {AppRegistry, Text, TurboModuleRegistry} from 'react-native';
import {SDK_VERSION} from '@latchway/react-native';

// A real native module, not the injectable test bridge. This host never signs
// in, calls a gateway, or claims App Attest / Play Integrity conformance.
const bridge = TurboModuleRegistry.getEnforcing('NativeLatchway');
if (typeof bridge.configure !== 'function' || typeof bridge.startRequest !== 'function') {
  throw new Error('Latchway TurboModule registration is incomplete');
}

function CompatibilityHost() {
  return React.createElement(Text, {testID: 'latchway-native-ready'},
    `Latchway ${SDK_VERSION}: native module ready`);
}

AppRegistry.registerComponent('HelloWorld', () => CompatibilityHost);
