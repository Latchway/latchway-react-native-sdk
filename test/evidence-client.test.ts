import { describe, expect, it } from "vitest";
import { freshClientAfterRevocation } from "../example/src/evidence-client.js";

describe("physical evidence client rotation", () => {
  it("revokes and disposes the terminal client before authorizing with a fresh client", async () => {
    const events: string[] = [];
    const current = {
      ready: Promise.resolve().then(() => { events.push("current.ready"); }),
      async revokeCurrentInstallation(): Promise<void> { events.push("current.revoke"); },
      async dispose(): Promise<void> { events.push("current.dispose"); },
      async authorize(): Promise<void> { throw new Error("terminal client must not be reused"); },
    };
    const rotated = await freshClientAfterRevocation(current, () => {
      events.push("replacement.create");
      return {
        ready: Promise.resolve().then(() => { events.push("replacement.ready"); }),
        async revokeCurrentInstallation(): Promise<void> { events.push("replacement.revoke"); },
        async dispose(): Promise<void> { events.push("replacement.dispose"); },
        async authorize(): Promise<void> { events.push("replacement.authorize"); },
      };
    });
    await rotated.authorize();

    expect(events).toEqual([
      "current.ready",
      "current.revoke",
      "current.dispose",
      "replacement.create",
      "replacement.ready",
      "replacement.authorize",
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
});
