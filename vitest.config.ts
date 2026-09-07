import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    clearMocks: true,
    coverage: { provider: "v8" },
    environment: "node",
    restoreMocks: true
  }
});
