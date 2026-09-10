import type {LatchwayAccount, LatchwayApp, LatchwayClient, LatchwayAppSnapshot} from '@latchway/react-native';

/** Application-owned transitions, not a screen singleton or auth implementation.
 * Native still enforces account identity and cleanup while JavaScript is paused. */
export class ChatAccountLifecycle {
  private pending: Promise<unknown> = Promise.resolve();
  private client: LatchwayClient | undefined;
  private generation: string | undefined;
  private account: LatchwayAccount | undefined;
  private identityOperation: AbortController | undefined;
  private epoch = 0;
  private cleanupError: unknown;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly app: () => Promise<LatchwayApp>, private readonly getIdToken: () => Promise<string>) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capture(): number { return this.epoch; }
  isCurrent(epoch: number): boolean { return this.epoch === epoch && this.cleanupError === undefined; }

  /** Call only after an explicit sign-in/Resume chat action, never from a remount. */
  activate(): Promise<void> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (this.cleanupError !== undefined) throw this.cleanupError;
      const app = await this.app();
      const before = await app.snapshot();
      if (before.state === 'retiring') throw new Error('Account cleanup must finish before chat.');
      const cancellation = new AbortController();
      this.identityOperation = cancellation;
      try {
        const active = await app.signIn({getIdToken: this.getIdToken, signal: cancellation.signal});
        if (epoch !== this.epoch) {
          await active.logout();
          throw new Error('Sign-in was superseded by account cleanup.');
        }
        this.account = active;
        this.accept(await app.snapshot());
      } finally {
        if (this.identityOperation === cancellation) this.identityOperation = undefined;
      }
    });
  }

  /** Token events refresh only our captured login; they never create an account. */
  refreshIdentity(): Promise<void> {
    const account = this.account;
    const epoch = this.epoch;
    return this.serial(async () => {
      if (!account || !this.isCurrent(epoch)) return;
      await account.updateIdToken({getIdToken: this.getIdToken});
    });
  }

  async connection(): Promise<LatchwayClient> {
    return this.serial(async () => {
      if (this.cleanupError !== undefined) throw this.cleanupError;
      const app = await this.app();
      let snapshot = await app.snapshot();
      if (snapshot.state === 'refreshRequired' && this.account) {
        await this.account.updateIdToken({getIdToken: this.getIdToken});
        snapshot = await app.snapshot();
      }
      if (snapshot.state !== 'active' || !snapshot.generationID) {
        throw new Error('Use Resume chat to activate your signed-in account.');
      }
      if (this.generation !== snapshot.generationID) {
        this.fence();
        await this.client?.dispose();
        this.client = undefined;
        this.generation = snapshot.generationID;
        // Native may have configured and signed in before RN. Verify this app's
        // supplied token against that account before attaching its chat UI.
        this.account = await app.currentAccount() ?? undefined;
        if (!this.account) throw new Error('The shared account changed. Use Resume chat.');
        await this.account.updateIdToken({getIdToken: this.getIdToken});
      }
      if (!this.client) {
        const epoch = this.epoch;
        const candidate = await this.account!.makeClient();
        if (epoch !== this.epoch) {
          await candidate.dispose();
          throw new Error('Account changed while attaching the chat surface.');
        }
        this.client = candidate;
      }
      return this.client;
    });
  }

  /** Fence UI synchronously, then retire the captured native generation offline.
   * Firebase sign-out belongs to the caller and must follow successful cleanup. */
  logout(capturedGeneration: string | undefined = this.generation): Promise<void> {
    this.fence();
    return this.serial(async () => {
      const app = await this.app();
      try {
        if (this.account && capturedGeneration === this.generation) await this.account.logout();
        else if (capturedGeneration) await app.logout(capturedGeneration);
        await this.client?.dispose();
        this.client = undefined;
        this.generation = undefined;
        this.account = undefined;
        this.cleanupError = undefined;
      } catch (error) {
        this.cleanupError = error;
        throw error;
      }
    });
  }

  /** An auth observer only retires old work. It never activates a new login. */
  identityChanged(): Promise<void> { return this.logout(); }

  /** Explicit application sign-out also cleans up an unobserved or retiring
   * account. Auth observers must keep using captured-generation logout above. */
  signOut(): Promise<void> {
    this.fence();
    return this.serial(async () => {
      const app = await this.app();
      try {
        await app.signOut();
        await this.client?.dispose();
        this.client = undefined;
        this.generation = undefined;
        this.account = undefined;
        this.cleanupError = undefined;
      } catch (error) {
        this.cleanupError = error;
        throw error;
      }
    });
  }

  /** Closing one RN surface releases its own lease. It never logs out the host. */
  disposeSurface(): Promise<void> {
    this.fence();
    return this.serial(async () => {
      await this.client?.dispose();
      this.client = undefined;
    });
  }

  private accept(snapshot: LatchwayAppSnapshot): void {
    if (snapshot.state !== 'active' || !snapshot.generationID) throw new Error('Account was not activated.');
    if (this.generation !== snapshot.generationID) this.fence();
    this.generation = snapshot.generationID;
  }

  private fence(): void {
    this.identityOperation?.abort();
    this.epoch++;
    for (const listener of this.listeners) listener();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
