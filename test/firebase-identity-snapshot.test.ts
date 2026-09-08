import {describe, expect, it, vi} from 'vitest';
import {FirebaseIdentitySnapshots} from '../Examples/LatchwayChat/src/firebase-identity-snapshot.js';

type User = {uid: string; tenantId: string | null};
function fixture() {
  const current = {appName: 'fixture-app', issuer: 'https://issuer.test', tenant: null as string | null,
    user: {uid: 'fixture-A', tenantId: null} as User | null};
  let complete: ((token: string) => void) | undefined;
  const token = vi.fn(() => new Promise<string>(resolve => { complete = resolve; }));
  const snapshots = new FirebaseIdentitySnapshots(() => ({...current}), token);
  return {current, token, snapshots, finish() {
    if (!complete) throw new Error('No pending fixture token');
    complete('fixture-token');
  }};
}

describe('example Firebase identity callback pairing', () => {
  it('accepts a same-principal token refresh that replaces the User wrapper', async () => {
    const f = fixture();
    const pending = f.snapshots.snapshot();
    f.current.user = {uid: 'fixture-A', tenantId: null};
    f.snapshots.observe(f.current.user);
    f.finish();
    await expect(pending).resolves.toEqual({issuer: 'https://issuer.test', subject: 'fixture-A', token: 'fixture-token'});
    expect(f.snapshots.diagnostic()).toEqual({identityStatus: 'snapshot-ready'});
    expect(f.token).toHaveBeenCalledOnce();
  });

  it.each(['sign-out', 'switch', 'aba', 'sign-out-back-in'] as const)('rejects %s while token retrieval is pending', async mode => {
    const f = fixture();
    const pending = f.snapshots.snapshot();
    if (mode === 'sign-out' || mode === 'sign-out-back-in') {
      f.current.user = null; f.snapshots.observe(null);
    } else {
      f.current.user = {uid: 'fixture-B', tenantId: null}; f.snapshots.observe(f.current.user);
    }
    if (mode === 'aba' || mode === 'sign-out-back-in') {
      f.current.user = {uid: 'fixture-A', tenantId: null}; f.snapshots.observe(f.current.user);
    }
    f.finish();
    await expect(pending).resolves.toBeNull();
    expect(f.snapshots.diagnostic()).toEqual({identityStatus: 'identity-changed'});
  });

  it('uses queued event identities so A→B→A is rejected even if currentUser already contains A', async () => {
    const f = fixture();
    const pending = f.snapshots.snapshot();
    f.current.user = {uid: 'fixture-A', tenantId: null};
    f.snapshots.observe({uid: 'fixture-B', tenantId: null});
    f.snapshots.observe(f.current.user);
    f.finish();
    await expect(pending).resolves.toBeNull();
  });

  it.each(['appName', 'issuer', 'tenant'] as const)('rejects changes to selected %s', async field => {
    const f = fixture();
    const pending = f.snapshots.snapshot();
    f.current[field] = 'changed-fixture-context';
    f.finish();
    await expect(pending).resolves.toBeNull();
  });

  it('rejects a tenant mismatch before fetching a token', async () => {
    const f = fixture();
    f.current.user = {uid: 'fixture-A', tenantId: 'different-tenant'};
    await expect(f.snapshots.snapshot()).resolves.toBeNull();
    expect(f.snapshots.diagnostic()).toEqual({identityStatus: 'tenant-mismatch'});
    expect(f.token).not.toHaveBeenCalled();
  });

  it('reports only a fixed category and approved auth code when token retrieval fails', async () => {
    const f = fixture();
    f.token.mockRejectedValueOnce({code: 'auth/user-token-expired', message: 'private fixture detail', token: 'private fixture token'});
    await expect(f.snapshots.snapshot()).resolves.toBeNull();
    expect(f.snapshots.diagnostic()).toEqual({identityStatus: 'token-error', identityAuthCode: 'auth/user-token-expired'});
    f.token.mockRejectedValueOnce({code: 'private-not-approved', message: 'private detail'});
    await f.snapshots.snapshot();
    expect(f.snapshots.diagnostic()).toEqual({identityStatus: 'token-error'});
  });

  it('returns signed-out without a token call or retained prior auth code', async () => {
    const f = fixture();
    f.current.user = null;
    await expect(f.snapshots.snapshot()).resolves.toBeNull();
    expect(f.token).not.toHaveBeenCalled();
    expect(f.snapshots.diagnostic()).toEqual({identityStatus: 'signed-out'});
  });
});
