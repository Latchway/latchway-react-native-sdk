const { transformSync } = require('@babel/core');
const vm = require('node:vm');

test('message-like Symbol.hasInstance is not consulted before initialization', () => {
  const source = `
    class Message {
      type = 'system';
      static [Symbol.hasInstance](value) { return value?.type === 'system'; }
    }
    globalThis.result = new Message().type;
  `;
  const compiled = transformSync(source, {
    filename: 'message-regression.js',
    configFile: require.resolve('../babel.config.js'),
  }).code;
  const context = { require };
  vm.runInNewContext(compiled, context);
  expect(context.result).toBe('system');
});
