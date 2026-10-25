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

// The playground ships inside @adtl/gateway: start it from the installed package and fetch its page.
writeFileSync(
  join(app, "playground.mjs"),
  `import { spawn } from "node:child_process";
// Its own process group, so stopping it also stops npm exec, sh and the playground's children (on Linux a
// signal to npx alone doesn't reach them, and the open pipe would keep this script waiting forever).
const p = spawn("npx", ["--no-install", "adtl-gateway", "playground", "--no-open", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"], detached: true });
const stop = async () => {
  const exited = new Promise((r) => p.once("exit", r));
  try { process.kill(-p.pid, "SIGINT"); } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  try { process.kill(-p.pid, "SIGKILL"); } catch {}
};
let out = "";
const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("playground did not start: " + out)), 30000);
  p.stdout.on("data", (d) => { out += d; const m = /http:\\/\\/localhost:\\d+/.exec(out); if (m) { clearTimeout(t); resolve(m[0]); } });
  p.on("exit", (code) => reject(new Error("playground exited with " + code + ": " + out)));
}).catch(async (err) => { await stop(); throw err; });
const html = await (await fetch(url)).text();
const r = await fetch(url + "/api/call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "github__list_repos", args: {} }) });
const call = await r.json();
await stop();
if (!html.includes("<html") || call.audit?.outcome !== "forwarded") { console.error("FAILED", html.slice(0, 80), call); process.exit(1); }
console.log("npx adtl-gateway playground → page served, calls go through the gateway ✓");
process.exit(0);
`,
);
console.log(run("node", ["playground.mjs"], app).trim());
