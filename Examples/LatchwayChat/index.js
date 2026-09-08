/**
 * @format
 */

import './src/runtime/polyfills';
import { AppRegistry } from 'react-native';
import App from './App';
import EmbeddedChat from './EmbeddedChat';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
AppRegistry.registerComponent('LatchwayEmbeddedChat', () => EmbeddedChat);
