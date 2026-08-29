interface RenewableClient {
  readonly ready: Promise<void>;
  revokeCurrentInstallation(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Retires the current installation and returns a newly configured client.
 * Revocation is terminal in both native SDKs, and the coordinator retains a
 * native client while any JavaScript lease remains. Disposal must therefore
 * complete before creating the replacement.
 */
export async function freshClientAfterRevocation<T extends RenewableClient>(
  current: T,
  create: () => T,
): Promise<T> {
  await current.ready;
  await current.revokeCurrentInstallation();
  await current.dispose();

  const replacement = create();
  try {
    await replacement.ready;
    return replacement;
  } catch (error) {
    try {
      await replacement.dispose();
    } catch {
      // Preserve the configuration failure. Disposal is best-effort here and
      // both native bridges define it as idempotent.
    }
    throw error;
  }
}
