import type {LatchwayApp, LatchwayClient, LatchwayAppSnapshot} from '@latchway/react-native';

/** Application-owned transitions, not a screen singleton or auth implementation.
 * Native still enforces account identity and cleanup while JavaScript is paused. */
export class ChatAccountLifecycle {
  private pending: Promise<unknown> = Promise.resolve();
  private client: LatchwayClient | undefined;
  private generation: string | undefined;
  private epoch = 0;
  private cleanupError: unknown;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly app: () => Promise<LatchwayApp>) {}

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
      // Explicit login intent may recover a persisted generation that this new
      // application process has never attached to. Capture before retiring; a
      // delayed logout callback is never allowed to discover the current user.
      if (!this.generation && before.state === 'active' && before.generationID) await app.logout(before.generationID);
      const active = await app.activate();
      if (epoch !== this.epoch) {
        if (active.generationID) await app.logout(active.generationID);
        throw new Error('Activation was superseded by account cleanup.');
      }
      this.accept(active);
    });
  }

  async connection(): Promise<LatchwayClient> {
    return this.serial(async () => {
      if (this.cleanupError !== undefined) throw this.cleanupError;
      const app = await this.app();
      const snapshot = await app.snapshot();
      if (snapshot.state !== 'active' || !snapshot.generationID) {
        throw new Error('Use Resume chat to activate your signed-in account.');
      }
      if (this.generation !== snapshot.generationID) {
        this.fence();
        await this.client?.dispose();
        this.client = undefined;
        this.generation = snapshot.generationID;
      }
      if (!this.client) {
        const epoch = this.epoch;
        const candidate = await app.makeClient();
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
        if (capturedGeneration) await app.logout(capturedGeneration);
        await this.client?.dispose();
        this.client = undefined;
        this.generation = undefined;
        this.cleanupError = undefined;
      } catch (error) {
        this.cleanupError = error;
        throw error;
      }
    });
  }

  /** An auth observer only retires old work. It never activates a new login. */
  identityChanged(): Promise<void> { return this.logout(); }

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
    this.epoch++;
    for (const listener of this.listeners) listener();
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.catch(() => undefined);
    return result;
  }
}
