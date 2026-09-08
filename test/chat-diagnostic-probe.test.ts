import {describe, expect, it, vi} from 'vitest';
import {runExistingIdentityProbe} from '../Examples/LatchwayChat/src/diagnostic-probe.js';

function fixture() {
  const order: string[] = [];
  return {
    order,
    debug: true, diagnoseEnabled: true, verificationEnabled: false, hasIdentity: true,
    reconcileIdentity: vi.fn(async () => { order.push('reconcile'); }),
    activate: vi.fn(async () => { order.push('activate'); }),
    send: vi.fn(async (_prompt: string, _mode: 'langchain') => { order.push('send'); }),
    reportSignInRequired: vi.fn(), reportActivationFailure: vi.fn(),
  };
}

describe('explicit existing-identity Debug probe', () => {
  it('awaits reconciliation and activation before send creates its controller and UI epoch', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    f.activate.mockImplementationOnce(async () => {
      f.order.push('activate');
      await new Promise<void>(resolve => { release = resolve; });
      f.order.push('activation-fence-finished');
    });
    const running = runExistingIdentityProbe(f);
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(f.send).not.toHaveBeenCalled();
    if (!release) throw new Error('Missing activation continuation');
    release();
    await running;
    expect(f.order).toEqual(['reconcile', 'activate', 'activation-fence-finished', 'send']);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(
      'In one sentence, explain how Latchway protects provider keys.', 'langchain');
  });

  it.each(['reconcileIdentity', 'activate'] as const)('%s failure stops before sending and is reported separately', async stage => {
    const f = fixture();
    const failure = new Error('fixture lifecycle failure');
    f[stage].mockRejectedValueOnce(failure);
    await runExistingIdentityProbe(f);
    expect(f.reportActivationFailure).toHaveBeenCalledExactlyOnceWith(failure);
    expect(f.send).not.toHaveBeenCalled();
    expect(f[stage]).toHaveBeenCalledOnce();
    if (stage === 'reconcileIdentity') expect(f.activate).not.toHaveBeenCalled();
  });

  it.each([{debug: false}, {diagnoseEnabled: false}, {verificationEnabled: true}])(
    'does nothing outside the explicit Debug diagnose gate: %j', async gate => {
      const f = fixture();
      await runExistingIdentityProbe({...f, ...gate});
      expect(f.order).toEqual([]);
      expect(f.reportActivationFailure).not.toHaveBeenCalled();
      expect(f.reportSignInRequired).not.toHaveBeenCalled();
    });

  it('requires an existing identity without creating or signing into an account', async () => {
    const f = fixture();
    await runExistingIdentityProbe({...f, hasIdentity: false});
    expect(f.order).toEqual([]);
    expect(f.reportSignInRequired).toHaveBeenCalledOnce();
    expect(f.reportActivationFailure).not.toHaveBeenCalled();
  });

  it('leaves send failure diagnostics untouched and never retries the fixed turn', async () => {
    const f = fixture();
    const failure = new Error('fixture dispatch failure');
    f.send.mockRejectedValueOnce(failure);
    await expect(runExistingIdentityProbe(f)).rejects.toBe(failure);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.reportActivationFailure).not.toHaveBeenCalled();
    expect(f.reportSignInRequired).not.toHaveBeenCalled();
  });
});
