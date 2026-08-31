import { describe, expect, it } from "vitest";
import { freshClientAfterRevocation } from "../example/src/evidence-client.js";

describe("physical evidence client rotation", () => {
  it("revokes and disposes the terminal client before fetching with a fresh client", async () => {
    const events: string[] = [];
    const current = {
      ready: Promise.resolve().then(() => { events.push("current.ready"); }),
      async revokeCurrentInstallation(): Promise<void> { events.push("current.revoke"); },
      async dispose(): Promise<void> { events.push("current.dispose"); },
      async fetch(): Promise<void> { throw new Error("terminal client must not be reused"); },
    };
    const rotated = await freshClientAfterRevocation(current, () => {
      events.push("replacement.create");
      return {
        ready: Promise.resolve().then(() => { events.push("replacement.ready"); }),
        async revokeCurrentInstallation(): Promise<void> { events.push("replacement.revoke"); },
        async dispose(): Promise<void> { events.push("replacement.dispose"); },
        async fetch(): Promise<void> { events.push("replacement.fetch"); },
      };
    });
    await rotated.fetch();

    expect(events).toEqual([
      "current.ready",
      "current.revoke",
      "current.dispose",
      "replacement.create",
      "replacement.ready",
      "replacement.fetch",
    ]);
  });

  it("disposes a replacement whose native compatibility check fails", async () => {
    const current = {
      ready: Promise.resolve(),
      async revokeCurrentInstallation(): Promise<void> {},
      async dispose(): Promise<void> {},
    };
    let disposed = false;

    await expect(freshClientAfterRevocation(current, () => ({
      ready: Promise.reject(new Error("incompatible")),
      async revokeCurrentInstallation(): Promise<void> {},
      async dispose(): Promise<void> { disposed = true; },
    }))).rejects.toThrow("incompatible");
    expect(disposed).toBe(true);
  });

  it("allows bounded diagnostics before disposing a failed replacement", async () => {
    const events: string[] = [];
    const current = {
      ready: Promise.resolve(),
      async revokeCurrentInstallation(): Promise<void> {},
      async dispose(): Promise<void> {},
    };
    const replacement = {
      ready: Promise.reject(new Error("attestation failed")),
      async revokeCurrentInstallation(): Promise<void> {},
      async dispose(): Promise<void> { events.push("dispose"); },
    };

    await expect(freshClientAfterRevocation(
      current,
      () => replacement,
      async (failed) => {
        expect(failed).toBe(replacement);
        events.push("diagnostics");
      },
    )).rejects.toThrow("attestation failed");
    expect(events).toEqual(["diagnostics", "dispose"]);
  });

  it("does not create a replacement when revocation fails", async () => {
    let created = false;
    const current = {
      ready: Promise.resolve(),
      async revokeCurrentInstallation(): Promise<void> { throw new Error("revoke failed"); },
      async dispose(): Promise<void> {},
    };

    await expect(freshClientAfterRevocation(current, () => {
      created = true;
      return current;
    })).rejects.toThrow("revoke failed");
    expect(created).toBe(false);
  });
});
