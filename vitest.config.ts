import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    env: {
      // Tests started from inside Claude Code would otherwise share real session files under ~/.adtl.
      CLAUDE_CODE_SESSION_ID: "",
      // A throwaway home, inherited by every process the tests start, so nothing touches the real ~/.adtl.
      HOME: mkdtempSync(join(tmpdir(), "adtl-test-home-")),
      ADTL_LEDGER: "",
      ADTL_SESSIONS_DIR: "",
    },
  },
});
