#!/usr/bin/env node
// Install the packed packages into an empty project, the way a user would,
// and run the gateway from there against the fake GitHub server.
//
//   npm run build && node scripts/pack-test.mjs

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "adtl-pack-"));
const tarballs = join(work, "tarballs");
const app = join(work, "app");
mkdirSync(tarballs);
mkdirSync(app);

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

for (const p of ["labels", "ledger", "interceptors", "gateway"]) {
  run("npm", ["pack", "--pack-destination", tarballs], join(root, "packages", p));
}
const files = readdirSync(tarballs).map((f) => join(tarballs, f));
console.log(`packed: ${readdirSync(tarballs).join(", ")}`);

writeFileSync(join(app, "package.json"), JSON.stringify({ name: "adtl-pack-test", private: true, type: "module" }));
run("npm", ["install", "--no-audit", "--no-fund", ...files], app);
console.log(`installed into ${app}`);

// A user's project: their own config and an MCP server (the fake GitHub one).
copyFileSync(join(root, "examples/fake-github/server.mjs"), join(app, "fake-github.mjs"));
copyFileSync(join(root, "examples/adtl.yaml"), join(app, "adtl.yaml"));
const yaml = run("node", ["-e", "process.stdout.write(require('fs').readFileSync('adtl.yaml','utf8').replace(/args: \\[fake-github\\/server.mjs\\]/, 'args: [fake-github.mjs]'))"], app);
// A ledger next to the config, so the test leaves nothing in ~/.adtl.
writeFileSync(join(app, "adtl.yaml"), `${yaml}\nledger:\n  path: ./ledger.db\n`);

writeFileSync(
  join(app, "check.mjs"),
  `import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const c = new Client({ name: "pack-test", version: "0" });
await c.connect(new StdioClientTransport({ command: "npx", args: ["--no-install", "adtl-gateway", "--config", "adtl.yaml"], stderr: "pipe" }));
const { tools } = await c.listTools();
await c.callTool({ name: "github__read_issue", arguments: { repo: "acme/website", number: 42 } });
await c.callTool({ name: "github__get_file", arguments: { repo: "acme/internal", path: "secrets.env" } });
const r = await c.callTool({ name: "github__post_comment", arguments: { repo: "acme/website", number: 42, body: "leak" } });
await c.close();
if (tools.length !== 4 || !r.isError || !r.content[0].text.includes("ADTL blocked this call")) {
  console.error("FAILED", tools.map((t) => t.name), r);
  process.exit(1);
}
console.log("gateway from the installed packages: " + tools.length + " tools, leak blocked ✓");
`,
);
console.log(run("node", ["check.mjs"], app).trim());

for (const bin of ["adtl-gateway", "adtl-interceptors"]) {
  const out = execFileSync("npx", ["--no-install", bin, "--version"], { cwd: app, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`npx ${bin} --version → ok`, out.trim());
}
