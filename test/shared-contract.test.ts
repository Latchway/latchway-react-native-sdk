import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("core-owned shared-native release consumption", () => {
  it("checks every vendored release byte and the canonical source pin", () => {
    const root = new URL("../", import.meta.url);
    const lock = JSON.parse(readFileSync(new URL("contract.shared-native.lock.json", root), "utf8")) as {
      status: string; core_release: string; core_commit: string; contract_version: string; wire_protocol: number;
      files: Record<string, string>;
    };
    expect(lock.status).toBe("released");
    expect(lock.core_release).toBe("v1.1.0");
    expect(lock.core_commit).toBe("0a60cbef57d904664430e235e1e165fea14f610b");
    expect(lock.contract_version).toBe("1.1.0");
    expect(lock.wire_protocol).toBe(3);
    expect(Object.keys(lock.files)).toHaveLength(5);
    for (const [path, hash] of Object.entries(lock.files)) {
      expect(createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex")).toBe(hash);
    }
    const legacy = JSON.parse(readFileSync(new URL("test/fixtures/contract/protocol-version.json", root), "utf8")) as {
      wire_protocol: { current: number };
    };
    expect(legacy.wire_protocol.current).toBe(3);
    const shared = JSON.parse(readFileSync(new URL("test/fixtures/contract/shared-native/shared-native-v3.json", root), "utf8")) as {
      caller_header: string; shared_sdk: string; invariants: Record<string, boolean>;
    };
    expect(shared.caller_header).toBe("X-Latchway-Caller");
    expect(shared.shared_sdk).toBe("native");
    expect(shared.invariants.server_policy_opt_in_required).toBe(true);
    expect(shared.invariants.caller_changes_quota_scope).toBe(false);
    expect(shared.invariants.root_credentials_exported_to_components).toBe(false);
  });
});
