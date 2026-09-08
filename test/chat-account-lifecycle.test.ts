import {describe, expect, it, vi} from 'vitest';
import type {LatchwayApp, LatchwayAppSnapshot, LatchwayClient} from '../src/index.js';
import {ChatAccountLifecycle} from '../Examples/LatchwayChat/src/account-lifecycle.js';

function fixture() {
  let state: LatchwayAppSnapshot = {appInstanceID: 'app', authorityInstanceID: 'owner', revision: 0, state: 'inactive'};
  let generation = 0;
  const clients: Array<{dispose: ReturnType<typeof vi.fn>}> = [];
  const app = {
    snapshot: vi.fn(async () => ({...state})),
    activate: vi.fn(async () => {
      state = {...state, state: 'active', generationID: String(++generation), revision: state.revision + 1};
      return {...state};
    }),
    logout: vi.fn(async (id: string) => {
      if (state.generationID === id) state = {...state, state: 'loggedOut', revision: state.revision + 1};
    }),
    makeClient: vi.fn(async () => {
      const client = {dispose: vi.fn(async () => undefined)};
      clients.push(client);
      return client as unknown as LatchwayClient;
    }),
  };
  const lifecycle = new ChatAccountLifecycle(async () => app as unknown as LatchwayApp);
  return {app, lifecycle, clients};
}

describe('runnable chat account integration', () => {
  it('never activates from connection or surface remount, and disposal is not logout', async () => {
    const f = fixture();
    await expect(f.lifecycle.connection()).rejects.toThrow('Resume chat');
    expect(f.app.activate).not.toHaveBeenCalled();
    await f.lifecycle.activate();
    const original = await f.lifecycle.connection();
    await f.lifecycle.disposeSurface();
    expect(f.clients[0]?.dispose).toHaveBeenCalledOnce();
    expect(f.app.logout).not.toHaveBeenCalled();
    expect(await f.lifecycle.connection()).not.toBe(original);
    expect(f.app.activate).toHaveBeenCalledOnce();
  });

  it('fences UI before cleanup awaits and only explicit login creates B', async () => {
    const f = fixture();
    await f.lifecycle.activate();
    await f.lifecycle.connection();
    const epoch = f.lifecycle.capture();
    const listener = vi.fn();
    f.lifecycle.subscribe(listener);
    const retired = f.lifecycle.identityChanged();
    expect(f.lifecycle.isCurrent(epoch)).toBe(false);
    expect(listener).toHaveBeenCalledOnce();
    await retired;
    expect(f.app.logout).toHaveBeenCalledWith('1');
    await expect(f.lifecycle.connection()).rejects.toThrow('Resume chat');
    await f.lifecycle.activate();
    await f.lifecycle.connection();
    expect((await f.app.snapshot()).generationID).toBe('2');
  });

  it('failed cleanup blocks activation and connection until an explicit logout retry', async () => {
    const f = fixture();
    await f.lifecycle.activate();
    f.app.logout.mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(f.lifecycle.logout()).rejects.toThrow('storage unavailable');
    await expect(f.lifecycle.activate()).rejects.toThrow('storage unavailable');
    await expect(f.lifecycle.connection()).rejects.toThrow('storage unavailable');
    await f.lifecycle.logout();
    await f.lifecycle.activate();
    expect(f.app.logout).toHaveBeenCalledTimes(2);
  });

  it('retires late activation before its promise can enable UI', async () => {
    const f = fixture();
    const original = f.app.activate.getMockImplementation();
    if (!original) throw new Error('Missing fixture implementation');
    let release: (() => void) | undefined;
    f.app.activate.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return original();
    });
    const activating = f.lifecycle.activate();
    await vi.waitFor(() => expect(release).toBeDefined());
    const logout = f.lifecycle.logout();
    if (!release) throw new Error('Expected pending activation');
    release();
    await expect(activating).rejects.toThrow('superseded');
    await logout;
    expect((await f.app.snapshot()).state).toBe('loggedOut');
  });

  it('disposes a late attachment instead of leaking an old client to the new UI', async () => {
    const f = fixture();
    await f.lifecycle.activate();
    const original = f.app.makeClient.getMockImplementation();
    if (!original) throw new Error('Missing fixture implementation');
    let release: (() => void) | undefined;
    f.app.makeClient.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => { release = resolve; });
      return original();
    });
    const attaching = f.lifecycle.connection();
    await vi.waitFor(() => expect(release).toBeDefined());
    const logout = f.lifecycle.logout();
    if (!release) throw new Error('Expected pending client');
    release();
    await expect(attaching).rejects.toThrow('attaching');
    await logout;
    expect(f.clients[0]?.dispose).toHaveBeenCalledOnce();
  });

  it('an unknown delayed generation never discovers and logs out an externally activated account', async () => {
    const f = fixture();
    const delayed = f.lifecycle.identityChanged();
    await f.app.activate();
    await delayed;
    expect(f.app.logout).not.toHaveBeenCalled();
    expect((await f.app.snapshot()).state).toBe('active');
    // Cold-launch cleanup is separate, with an explicitly captured snapshot.
    const captured = await f.app.snapshot();
    await f.app.activate();
    await f.lifecycle.logout(captured.generationID);
    expect(f.app.logout).toHaveBeenCalledWith('1');
    expect((await f.app.snapshot()).generationID).toBe('2');
  });
});
