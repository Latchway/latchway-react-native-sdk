import {LatchwayError} from '@latchway/client';
import {chatErrorDetail} from '../src/error-display';

test('shows typed actionable detail, correlation, retry time and safe field guidance', () => {
  const error = new LatchwayError('quota_exceeded', 'The weekly token allowance is exhausted.', {
    status: 429, requestID: 'req_12345678', retryable: true, retryAfter: '2026-09-14T00:00:00Z',
    validationErrors: [{path: 'quota.total_tokens', message: 'Wait for the weekly allowance to reset.'}],
  });
  const text = chatErrorDetail(error);
  expect(text).toContain(error.message);
  expect(text).toContain('Request ID: req_12345678');
  expect(text).toContain('2026-09-14T00:00:00.000Z');
  expect(text).toContain('quota.total_tokens');
  expect(text).toContain('No automatic retry was sent.');
});

test('extracts canonical gateway detail from framework error wrappers', () => {
  const error = {error: {
    code: 'request_invalid', detail: 'Function tool parameters must be an object.',
    type: 'https://docs.latchway.dev/errors/request-invalid',
    documentation_url: 'https://docs.latchway.dev/errors/request-invalid',
    request_id: 'req_12345678',
  }};
  expect(chatErrorDetail(error)).toContain('Function tool parameters must be an object.');
  expect(chatErrorDetail(error)).toContain('req_12345678');
});

test('recognizes a typed error from a second compatible client package copy', () => {
  const error = {
    name: 'LatchwayError', code: 'attestation_invalid', message: 'The application evidence did not match policy.',
    documentationURL: 'https://docs.latchway.dev/errors/attestation-invalid', requestID: 'req_12345678',
  };
  expect(chatErrorDetail(error)).toContain(error.message);
  expect(chatErrorDetail(error)).toContain('req_12345678');
});

test('does not display arbitrary provider bodies or credential-shaped detail', () => {
  expect(chatErrorDetail(new Error('private provider response'))).toBeUndefined();
  expect(chatErrorDetail({code: 'network_error', detail: 'private provider response'})).toBeUndefined();
  const error = new LatchwayError('network_error', `identity_token eyJ${'a'.repeat(80)}`);
  expect(chatErrorDetail(error)).toContain('Sensitive error detail was redacted.');
  expect(chatErrorDetail(error)).not.toContain('eyJ');
});
