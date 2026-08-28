import { describe, expect, it } from "vitest";
import { isCanonicalRequestID } from "../src/request-id.js";

const ANDROID_REQUEST_ID = "android:550e8400-e29b-41d4-a716-446655440000";

describe("canonical request IDs", () => {
  it("accepts Android-generated and server-canonical request IDs", () => {
    expect(isCanonicalRequestID(ANDROID_REQUEST_ID)).toBe(true);
    expect(isCanonicalRequestID("server.request_id:retry-1")).toBe(true);
  });

  it.each([
    ["whitespace", `${ANDROID_REQUEST_ID} `],
    ["control characters", `${ANDROID_REQUEST_ID}\u0000`],
    ["oversize values", `a${"b".repeat(128)}`],
    ["leading punctuation", `:${ANDROID_REQUEST_ID}`],
  ])("rejects %s", (_case, requestID) => {
    expect(isCanonicalRequestID(requestID)).toBe(false);
  });
});
