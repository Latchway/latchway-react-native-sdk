const {transformSync} = require('@babel/core');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {URL, URLSearchParams} = require('node:url');

function compile(filename) {
  return transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, configFile: require.resolve('../babel.config.js'),
  }).code;
}

function reactNativeURL(name) {
  const filename = path.join(path.dirname(require.resolve('react-native/package.json')), 'Libraries/Blob', name + '.js');
  const module = {exports: {}};
  const globals = name === 'URL' ? {URLSearchParams: reactNativeURL('URLSearchParams').URLSearchParams} : {};
  vm.runInNewContext(`(function(require, module, exports) {${compile(filename)}\n})`, globals)(
    id => id === './NativeBlobModule' ? {__esModule: true, default: null} :
      id === './URLSearchParams' ? reactNativeURL('URLSearchParams') : require(id),
    module, module.exports,
  );
  return module.exports;
}

function bootstrap(globals) {
  const context = {...globals, AbortSignal: global.AbortSignal, navigator: {}, exports: {}};
  context.require = id => {
    if (id === './symbols' || id === 'react-native-get-random-values') return {};
    if (id === 'react-native-url-polyfill') return {URL, URLSearchParams};
    return require(id);
  };
  vm.runInNewContext(compile(require.resolve('../src/runtime/polyfills.ts')), context);
  return context;
}

test('replaces the actual RN URL even though it passes the old query-only probe', () => {
  const native = reactNativeURL('URL');
  const query = new native.URL('child?q=hello%20world', 'https://example.invalid/root/');
  expect(query.href).toBe('https://example.invalid/root/child?q=hello%20world');
  expect(query.searchParams.get('q')).toBe('hello world');
  expect(new native.URLSearchParams({q: 'hello world'}).get('q')).toBe('hello world');
  expect(new native.URL('https://example.invalid/v1/responses').pathname).toBe('/v1/responses/');
  const env = bootstrap(native);
  expect(env.URL).toBe(URL);
  expect(new env.URL('https://example.invalid/v1/responses').pathname).toBe('/v1/responses');
});

test('keeps an existing complete host URL implementation', () => {
  const env = bootstrap({URL, URLSearchParams});
  expect(env.URL).toBe(URL);
  expect(env.URLSearchParams).toBe(URLSearchParams);
});
