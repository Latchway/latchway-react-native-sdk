const requestIDPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

export function isCanonicalRequestID(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128 && requestIDPattern.test(value);
}
