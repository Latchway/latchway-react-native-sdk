import {diagnosticLocation, errorLocation, knownFailure} from '../src/diagnostic';

test('diagnostics retain code locations but never exception text or source URLs', () => {
  const error = new Error('secret-message');
  error.stack = 'Error: secret-message\nprovider response: hidden\n' +
    '    at openStream (address at https://example.invalid/index.bundle?token=secret:1:12345)\n' +
    '    at anonymous (address at index.ios.bundle:1:999)';
  expect(errorLocation(error)).toBe('openStream:1:12345\nanonymous:1:999');
  expect(errorLocation({message: 'secret'})).toBe('');
});

test('diagnostics bound untrusted stack text', () => {
  const error = new Error();
  error.stack = 'Error\n' + '    at run (index.bundle:1:2)\n'.repeat(50);
  expect(errorLocation(error).split('\n')).toHaveLength(5);
});

test('wrapped failures retain safe cause locations and classify only known static errors', () => {
  const cause = new Error('Native module not found');
  cause.stack = 'Error\n    at getRandomBase64 (bundle:1:123)';
  const error = new Error('Connection failed');
  Object.assign(error, {cause});
  error.stack = 'Error\n    at _construct (bundle:1:1)\n    at APIConnectionError (bundle:1:2)\n    at dispatch (bundle:1:3)';
  expect(diagnosticLocation(error)).toBe('dispatch:1:3\ncause:\ngetRandomBase64:1:123');
  expect(knownFailure(error)).toBe('native_random_module_missing');
  expect(knownFailure(new Error('private upstream message'))).toBeUndefined();
});
