import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {nativeModule, setTestingNativeModule, type NativeLatchwayModule} from '../src/native/bridge.js';

const registry = vi.hoisted(() => ({getEnforcing: vi.fn()}));
vi.mock('react-native', () => ({TurboModuleRegistry: registry}));

beforeEach(() => { registry.getEnforcing.mockReset(); setTestingNativeModule(undefined); });
afterEach(() => { setTestingNativeModule(undefined); });

describe('lazy native registry lookup', () => {
  it('does not construct native modules while importing the resolver', async () => {
    const resolver = await import('../src/native/resolve-native-module.js');
    expect(typeof resolver.resolveNativeModule).toBe('function');
    expect(registry.getEnforcing).not.toHaveBeenCalled();
  });

  it('uses one exact enforcing lookup and retains the native object identity', async () => {
    const native = {configure: vi.fn(), dispose: vi.fn()};
    registry.getEnforcing.mockReturnValue(native);
    expect(await nativeModule()).toBe(native);
    expect(registry.getEnforcing).toHaveBeenCalledExactlyOnceWith('NativeLatchway');
    expect(native.configure).not.toHaveBeenCalled();
    expect(native.dispose).not.toHaveBeenCalled();
  });

  it('keeps the original registry failure as the cause instead of a later undefined property error', async () => {
    const original = new Error('fixture registration failure');
    registry.getEnforcing.mockImplementationOnce(() => { throw original; });
    await expect(nativeModule()).rejects.toMatchObject({name: 'LatchwayNativeModuleUnavailable', cause: original});
    expect(registry.getEnforcing).toHaveBeenCalledOnce();
    // A new explicit attempt is not poisoned by a failed Metro module factory.
    const native = {configure: vi.fn()};
    registry.getEnforcing.mockReturnValueOnce(native);
    expect(await nativeModule()).toBe(native);
    expect(registry.getEnforcing).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, false, 1, 'not-native'])(
    'fails closed if a broken registry returns %j', async value => {
      registry.getEnforcing.mockReturnValue(value);
      await expect(nativeModule()).rejects.toMatchObject({name: 'LatchwayNativeModuleUnavailable'});
      expect(registry.getEnforcing).toHaveBeenCalledOnce();
    });

  it('keeps the explicit test seam separate from the production registry', async () => {
    const fixture = {} as NativeLatchwayModule;
    setTestingNativeModule(fixture);
    expect(await nativeModule()).toBe(fixture);
    expect(registry.getEnforcing).not.toHaveBeenCalled();
  });
});
