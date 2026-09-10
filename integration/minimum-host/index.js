import React from 'react';
import {AppRegistry, Text, TurboModuleRegistry} from 'react-native';
import {SDK_VERSION, Latchway, createLatchwayComponentClient} from '@latchway/react-native';

// A real native module, not the injectable test bridge. This host never signs
// in, calls a gateway, or claims App Attest / Play Integrity conformance.
const bridge = TurboModuleRegistry.getEnforcing('NativeLatchway');
if (typeof bridge.appCommand !== 'function' || typeof bridge.startRequest !== 'function' ||
    typeof bridge.configureComponent !== 'function' || typeof bridge.configure === 'function' ||
    typeof bridge.establishDirectAttestation === 'function' || typeof bridge.revokeFamilyWithComponents === 'function' ||
    typeof Latchway.configure !== 'function' || typeof Latchway.getApp !== 'function' ||
    typeof createLatchwayComponentClient !== 'function') {
  throw new Error('Latchway TurboModule registration is incomplete');
}

function CompatibilityHost() {
  return React.createElement(Text, {testID: 'latchway-native-ready'},
    `Latchway ${SDK_VERSION}: native module ready`);
}

AppRegistry.registerComponent('HelloWorld', () => CompatibilityHost);
