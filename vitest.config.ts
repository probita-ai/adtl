import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Tests started from inside Claude Code would otherwise share real session files under ~/.adtl.
    env: { CLAUDE_CODE_SESSION_ID: "" },
  },
});
