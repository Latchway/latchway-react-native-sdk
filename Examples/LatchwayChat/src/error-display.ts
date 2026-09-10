import {LatchwayError} from '@latchway/client';

/** Display only typed gateway detail, never arbitrary provider/transport bodies. */
export function chatErrorDetail(error: unknown): string | undefined {
  const root = record(error);
  const candidates = [error, root?.error, root?.cause];
  for (const candidate of candidates) {
    const value = record(candidate);
    if (!value) continue;
    const code = value.code;
    if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/.test(code)) continue;
    const documentationURL = `https://docs.latchway.dev/errors/${code.replace(/_/g, '-')}`;
    const canonical = value.documentation_url === documentationURL && value.type === documentationURL;
    // A host can temporarily have two compatible client package copies during an
    // upgrade. Do not depend only on constructor identity across that boundary.
    const typed = candidate instanceof LatchwayError ||
      (value.name === 'LatchwayError' && value.documentationURL === documentationURL);
    if (!typed && !canonical) continue;
    const detail = typed ? value.message : value.detail;
    if (typeof detail !== 'string' || detail.length === 0 || detail.length > 2048) continue;
    const parts = [safe(detail), `Code: ${code}.`];
    const requestID = value.requestID ?? value.request_id;
    if (typeof requestID === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestID)) {
      parts.push(`Request ID: ${requestID}.`);
    }
    const retryAfter = value.retryAfter ?? value.retry_after;
    if (typeof retryAfter === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(retryAfter) && Number.isFinite(Date.parse(retryAfter))) {
      parts.push(`Try again after ${new Date(retryAfter).toISOString()}.`);
    }
    const fields = value.validationErrors ?? value.errors;
    if (Array.isArray(fields)) {
      for (const field of fields.slice(0, 3)) {
        const item = record(field);
        if (typeof item?.path === 'string' && typeof item.message === 'string') {
          parts.push(`${safe(item.path)}: ${safe(item.message)}`);
        }
      }
    }
    parts.push('No automatic retry was sent.');
    return parts.join('\n');
  }
  return undefined;
}

function safe(value: string): string {
  const bounded = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 512);
  return /eyJ|lwa_|lws_|refresh.?token|identity.?token|integrity.?token|[A-Za-z0-9_-]{64,}/i.test(bounded)
    ? 'Sensitive error detail was redacted.' : bounded;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
