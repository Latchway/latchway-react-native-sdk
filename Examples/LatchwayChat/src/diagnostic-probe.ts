type ExistingIdentityProbe = {
  debug: boolean;
  diagnoseEnabled: boolean;
  verificationEnabled: boolean;
  hasIdentity: boolean;
  reconcileIdentity: () => Promise<void>;
  activate: () => Promise<void>;
  send: (prompt: string, mode: 'langchain') => Promise<unknown>;
  reportSignInRequired: () => void;
  reportActivationFailure: (error: unknown) => void;
};

/** Explicit Debug launch intent, equivalent to Resume chat followed by one
 * fixed turn. Normal mounts never activate. This helper owns no Firebase,
 * installation revocation, retries, or alternate transport path. */
export async function runExistingIdentityProbe(options: ExistingIdentityProbe): Promise<void> {
  if (!options.debug || !options.diagnoseEnabled || options.verificationEnabled) return;
  if (!options.hasIdentity) {
    options.reportSignInRequired();
    return;
  }
  try {
    await options.reconcileIdentity();
    // Complete activation's UI fence before send creates its controller/epoch.
    await options.activate();
  } catch (error) {
    options.reportActivationFailure(error);
    return;
  }
  // send owns its detailed redacted diagnostic and must not be retried or
  // reclassified as an activation failure if dispatch fails.
  await options.send('In one sentence, explain how Latchway protects provider keys.', 'langchain');
}
