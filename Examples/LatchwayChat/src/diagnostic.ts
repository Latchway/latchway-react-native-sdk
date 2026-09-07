// Never persist exception messages, request bodies, tokens or source URLs.
export function errorLocation(error: unknown): string {
  if (!(error instanceof Error)) return '';
  const sites: string[] = [];
  for (const line of (error.stack ?? '').split('\n').slice(1)) {
    const match = /^\s*at ([A-Za-z0-9_.$<> ]{1,80}) \(.*?:(\d+):(\d+)\)$/.exec(line);
    if (match) {
      const name = match[1].trim();
      if (['_construct', 'Wrapper', '_callSuper'].includes(name) || name.endsWith('Error')) continue;
      sites.push(`${name}:${match[2]}:${match[3]}`);
    }
    if (sites.length === 5) break;
  }
  return sites.join('\n').slice(0, 500);
}

export function diagnosticLocation(error: unknown): string {
  const cause = (error as {cause?: unknown})?.cause;
  return [errorLocation(error), cause ? 'cause:\n' + errorLocation(cause) : ''].filter(Boolean).join('\n').slice(0, 500);
}

export function knownFailure(error: unknown): string | undefined {
  const candidates = [error, (error as {cause?: unknown})?.cause];
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) continue;
    if (candidate.message === 'Native module not found') return 'native_random_module_missing';
    if (candidate.message.includes('crypto.getRandomValues() not supported')) return 'secure_random_unavailable';
    if (candidate.message.startsWith('It looks like you\'re running in a browser-like environment.')) return 'browser_runtime_rejected';
    if (candidate.message.startsWith('Missing credentials.')) return 'adapter_placeholder_missing';
  }
  return undefined;
}
