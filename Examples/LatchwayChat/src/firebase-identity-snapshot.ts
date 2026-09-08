type UserIdentity = {readonly uid: string; readonly tenantId?: string | null};
type IdentityContext<User> = {
  appName: string;
  issuer: string;
  tenant: string | null;
  user: User | null;
};
type IdentityStatus = 'not-requested' | 'signed-out' | 'tenant-mismatch' |
  'token-error' | 'token-unavailable' | 'identity-changed' | 'snapshot-ready';

const safeAuthCodes = new Set([
  'auth/network-request-failed', 'auth/user-token-expired', 'auth/invalid-user-token',
  'auth/user-disabled', 'auth/user-not-found', 'auth/too-many-requests',
  'auth/internal-error', 'auth/unknown',
]);

/** RNFirebase replaces User wrappers on token refresh. Compare the logical
 * identity plus an observed transition epoch, never object reference equality.
 * This only pairs the callback; the gateway authenticates the returned token. */
export class FirebaseIdentitySnapshots<User extends UserIdentity> {
  private epoch = 0;
  private observed: string;
  private status: IdentityStatus = 'not-requested';
  private authCode: string | undefined;

  constructor(private readonly current: () => IdentityContext<User>,
    private readonly tokenFor: (user: User) => Promise<string>) {
    this.observed = this.key(current());
  }

  /** Use the event payload, not currentUser: a queued B event still fences
   * a request even when currentUser has already switched back to A. */
  observe(user: User | null): void {
    this.observeContext({...this.current(), user});
  }

  diagnostic(): {identityStatus: IdentityStatus; identityAuthCode?: string} {
    return {identityStatus: this.status, ...(this.authCode ? {identityAuthCode: this.authCode} : {})};
  }

  async snapshot(): Promise<{issuer: string; subject: string; token: string; tenant?: string} | null> {
    const before = this.current();
    this.observeContext(before);
    this.authCode = undefined;
    if (!before.user) { this.status = 'signed-out'; return null; }
    if ((before.user.tenantId ?? null) !== before.tenant) { this.status = 'tenant-mismatch'; return null; }
    const epoch = this.epoch;
    const identity = this.key(before);
    const subject = before.user.uid;
    let token: string;
    try {
      token = await this.tokenFor(before.user);
    } catch (error) {
      this.status = 'token-error';
      const code = (error as {code?: unknown} | null)?.code;
      if (typeof code === 'string' && safeAuthCodes.has(code)) this.authCode = code;
      return null;
    }
    const after = this.current();
    this.observeContext(after);
    if (epoch !== this.epoch || identity !== this.key(after)) { this.status = 'identity-changed'; return null; }
    if (typeof token !== 'string' || token.length === 0 || token.length > 65_536) {
      this.status = 'token-unavailable'; return null;
    }
    this.status = 'snapshot-ready';
    return {issuer: before.issuer, subject, token, ...(before.tenant === null ? {} : {tenant: before.tenant})};
  }

  private observeContext(context: IdentityContext<User>): void {
    const key = this.key(context);
    if (this.observed !== key) { this.observed = key; this.epoch++; }
  }

  private key(context: IdentityContext<User>): string {
    return JSON.stringify([context.appName, context.issuer, context.tenant,
      context.user?.uid ?? null, context.user?.tenantId ?? null]);
  }
}
