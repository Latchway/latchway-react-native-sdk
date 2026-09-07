const {transformSync} = require('@babel/core');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('installs stable async symbols before stream classes evaluate', () => {
  const source = fs.readFileSync(path.join(path.dirname(require.resolve('@latchway/react-native/package.json')), 'lib/runtime-symbols.js'), 'utf8');
  const compiled = transformSync(source, {
    filename: 'symbols.js', configFile: require.resolve('../babel.config.js'),
  }).code;
  const runtimeSymbol = {for: Symbol.for};
  const context = {Symbol: runtimeSymbol, Object, exports: {}};
  vm.runInNewContext(compiled, context);
  expect(typeof runtimeSymbol.asyncIterator).toBe('symbol');
  expect(runtimeSymbol.asyncIterator).toBe(Symbol.for('Symbol.asyncIterator'));
  const first = runtimeSymbol.asyncIterator;
  vm.runInNewContext(compiled, context);
  expect(runtimeSymbol.asyncIterator).toBe(first);
});

test('the entrypoint initializes symbols before stream dependencies', () => {
  const entry = fs.readFileSync(require.resolve('../index.js'), 'utf8');
  const bootstrap = entry.indexOf("import '@latchway/react-native/polyfills'");
  expect(bootstrap).toBeGreaterThanOrEqual(0);
  expect(bootstrap).toBeLessThan(entry.indexOf("from 'react-native'"));
  expect(bootstrap).toBeLessThan(entry.indexOf("import App from './App'"));
});
