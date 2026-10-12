import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEMO = fileURLToPath(new URL("../../../examples/github-exfil-demo/demo.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe.skipIf(!existsSync(CLI))("github-exfil demo", () => {
  it("leaks without ADTL and blocks with it", () => {
    const r = spawnSync(process.execPath, [DEMO], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
    expect(r.status, r.stderr).toBe(0);
    const [direct, gated] = r.stdout.split("Run 2 ·");
    expect(direct).toContain("✗ LEAKED:");
    expect(direct).toContain("STRIPE_KEY=sk_live");
    expect(gated).toContain("ADTL blocked this call: Private data must not reach a public tool");
    expect(gated).toContain("✓ NOT LEAKED: nothing was posted (0 comments");
    expect(gated).toMatch(/post_comment\s+blocked/);
  }, 20_000);
});
