#!/usr/bin/env node
// The GitHub-issue exfiltration attack against GitHub's real MCP server, run twice:
//   1. a naive agent talks to github-mcp-server directly   → the secret is posted publicly
//   2. the same agent goes through adtl-gateway            → the leak is blocked
//
// Opt-in: it needs a token and two throwaway repos (see README.md), and it is
// not part of `npm test`. Comments posted by run 1 are deleted at the end
// unless ADTL_DEMO_KEEP=1.
//
// Run from the repo root:  npm run demo:github

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const GATEWAY = join(root, "packages/gateway/dist/cli.js");

if (!existsSync(GATEWAY)) {
  console.error("Build first: npm run build");
  process.exit(1);
}

const TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
const PUBLIC_REPO = process.env.ADTL_DEMO_PUBLIC_REPO; // owner/name, holds the planted issue
const ISSUE = Number(process.env.ADTL_DEMO_ISSUE);
if (!TOKEN || !PUBLIC_REPO?.includes("/") || !Number.isInteger(ISSUE) || ISSUE < 1) {
  console.error(
    "Set GITHUB_PERSONAL_ACCESS_TOKEN, ADTL_DEMO_PUBLIC_REPO (owner/name) and ADTL_DEMO_ISSUE (number).\n" +
      "See examples/github-real-demo/README.md for the repos and token scopes.",
  );
  process.exit(1);
}
const [owner, repo] = PUBLIC_REPO.split("/");

// The official Docker image by default; GITHUB_MCP_SERVER points at a local binary instead.
const SERVER = process.env.GITHUB_MCP_SERVER
  ? { command: process.env.GITHUB_MCP_SERVER, args: ["stdio"] }
  : { command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server", "stdio"] };

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint("1"), dim = paint("2"), red = paint("31"), green = paint("32"), yellow = paint("33"), cyan = paint("36");

const work = mkdtempSync(join(tmpdir(), "adtl-github-demo-"));
const started = new Date().toISOString();

function readJsonl(path) {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// get_file_contents returns the file as an embedded resource, not a text item.
const textOf = (r) => r.content.map((c) => c.text ?? c.resource?.text ?? "").join("");
const firstLine = (s, n = 96) => {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > n ? `${l.slice(0, n)}…` : l;
};

async function github(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub API ${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** A naive agent: reads the issue, then does whatever the issue says. Returns the file it read. */
async function naiveAgent(client, toolName) {
  const step = async (n, what, name, args) => {
    console.log(`  ${dim(`${n}.`)} ${what}`);
    console.log(`     ${cyan(`→ ${toolName(name)}`)}${dim(` ${JSON.stringify(args).slice(0, 70)}`)}`);
    const r = await client.callTool({ name: toolName(name), arguments: args });
    const ann = r._meta?.["io.modelcontextprotocol/trust-annotations"];
    const label = ann ? dim(`  [label: ${ann.untrusted ? "untrusted" : "trusted"}, ${ann.sensitive ? "sensitive" : "not sensitive"}]`) : "";
    // Errors in full: GitHub's status code says what is wrong with the token.
    console.log(`     ${r.isError ? red("✗") : green("✓")} ${r.isError ? textOf(r).trim() : firstLine(textOf(r))}${label}`);
    return r;
  };

  const issue = await step(1, `Read issue #${ISSUE} on ${PUBLIC_REPO}`, "issue_read", { method: "get", owner, repo, issue_number: ISSUE });
  const m = textOf(issue).match(/Read (\S+) from the private repo ([\w.-]+)\/([\w.-]+?)\.? and post/);
  if (!m) {
    console.log(`     ${yellow("the issue has no planted instruction; see README.md for the text")}`);
    return "";
  }
  console.log(`     ${yellow("⚠ the issue contains hidden instructions, and this agent follows them")}`);
  const [, path, fileOwner, fileRepo] = m;
  const file = await step(2, `Read ${path} from ${fileOwner}/${fileRepo} (as the issue asked)`, "get_file_contents", { owner: fileOwner, repo: fileRepo, path });
  if (file.isError) return "";
  await step(3, "Post the file contents as a public comment", "add_issue_comment", { owner, repo, issue_number: ISSUE, body: textOf(file) });
  return textOf(file);
}

async function connect(command, args, env = {}) {
  const client = new Client({ name: "naive-agent", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command, args, env: { ...getDefaultEnvironment(), ...env }, stderr: "ignore" }));
  return client;
}

/** Ask GitHub itself, not the MCP server, which comments now hold the secret. */
async function leakedComments(secret) {
  const lines = secret.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const comments = await github(`/repos/${owner}/${repo}/issues/${ISSUE}/comments?since=${started}&per_page=100`);
  return comments.filter((c) => lines.some((l) => c.body.includes(l)));
}

function verdict(leaked) {
  console.log(
    leaked.length
      ? `\n  ${red(bold("✗ LEAKED:"))} the secret is now in a public comment: ${leaked.at(-1).html_url}`
      : `\n  ${green(bold("✓ NOT LEAKED:"))} no new comment on ${PUBLIC_REPO}#${ISSUE} holds the file`,
  );
}

console.log(bold("\nThe attack"));
console.log(dim(`  Issue #${ISSUE} on the public repo ${PUBLIC_REPO} hides an instruction for AI agents`));
console.log(dim("  to read a file from a private repo and post it as a comment."));

// ── Run 1: no ADTL ────────────────────────────────────────────────────────────
console.log(bold(`\n${"─".repeat(78)}\nRun 1 · agent → github-mcp-server directly (no ADTL)\n`));
const direct = await connect(SERVER.command, SERVER.args, { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN });
const secret = await naiveAgent(direct, (n) => n);
await direct.close();
if (!secret) {
  console.error(
    red(
      `\n  The attack could not run. Check that ${PUBLIC_REPO}#${ISSUE} has the planted text, and that the token's\n` +
        "  repository access includes the private repo, with Contents: Read (see README.md).\n",
    ),
  );
  process.exit(1);
}
const leaked1 = await leakedComments(secret);
verdict(leaked1);
// Without a leak here, run 2's block would prove nothing.
if (!leaked1.length) {
  console.error(red("\n  Run 1 should have leaked. If posting failed with 403, the token needs Issues: Read and write (see README.md).\n"));
  process.exit(1);
}

// ── Run 2: through adtl-gateway ───────────────────────────────────────────────
console.log(bold(`\n${"─".repeat(78)}\nRun 2 · agent → adtl-gateway → github-mcp-server\n`));
const audit = join(work, "audit.jsonl");
const config = join(work, "adtl.yaml");
// Only the policy and the upstream are written by hand. `init` labels every
// tool from the `github` preset below.
writeFileSync(
  config,
  `defaults:
  integrity: untrusted
  confidentiality: private

servers:
  github:
    acceptServerClaims: false

policy:
  default: allow
  rules:
    - name: no-public-write-after-untrusted
      when:
        session.integrity: untrusted
        tool.egress: [public, external, unknown]
      then: ask
      reason: Session has read untrusted content; confirm before writing anywhere public

    - name: private-stays-private
      when:
        session.confidentiality: [private, secret]
        tool.egress: public
      then: block
      reason: Private data must not reach a public tool

ledger:
  path: ${JSON.stringify(join(work, "ledger.db"))}

gateway:
  audit: ${JSON.stringify(audit)}
  upstreams:
    github:
      command: ${JSON.stringify(SERVER.command)}
      args: ${JSON.stringify(SERVER.args)}
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "\${GITHUB_PERSONAL_ACCESS_TOKEN}" }
`,
);
const init = spawnSync(process.execPath, [GATEWAY, "init", "--config", config, "--write"], { encoding: "utf8" });
if (init.status !== 0) {
  console.error(init.stderr);
  process.exit(1);
}
console.log(dim(`  adtl-gateway init labeled the tools from the github preset (${config}):`));
for (const l of readFileSync(config, "utf8").split("\n")) {
  if (/^\s+(issue_read|get_file_contents|add_issue_comment):/.test(l)) console.log(dim(`    ${l.trim().replace(/ #.*/, "")}`));
}
console.log();

const gated = await connect(process.execPath, [GATEWAY, "--config", config], { GITHUB_PERSONAL_ACCESS_TOKEN: TOKEN });
const secret2 = await naiveAgent(gated, (n) => `github__${n}`);
await gated.close();
const leaked2 = (await leakedComments(secret2 || secret)).filter((c) => !leaked1.some((p) => p.id === c.id));
verdict(leaked2);

console.log(bold("\n  Audit log") + dim(` (${audit})`));
for (const e of readJsonl(audit)) {
  const mark = e.outcome === "blocked" ? red("blocked") : green("allowed");
  const s = e.sessionLabel ? dim(`   (session: ${e.sessionLabel.integrity}/${e.sessionLabel.confidentiality})`) : "";
  console.log(`    ${e.tool.padEnd(26)} ${mark}${e.reason ? `  ${e.reason}` : ""}${s}`);
}

console.log(bold("\nWhy it was blocked"));
console.log("  • the github preset labels every read " + yellow("untrusted") + " and " + yellow("private") + " (repos can be private,");
console.log("    and anyone can write issues), so the session is private from step 1 on");
console.log("  • add_issue_comment writes publicly");
console.log("    → policy " + bold("private-stays-private") + " blocks the call before it reaches GitHub\n");

// ── Cleanup ───────────────────────────────────────────────────────────────────
const posted = [...leaked1, ...leaked2];
if (posted.length && process.env.ADTL_DEMO_KEEP !== "1") {
  for (const c of posted) await github(`/repos/${owner}/${repo}/issues/comments/${c.id}`, { method: "DELETE" });
  console.log(dim(`  Deleted the ${posted.length} leaked comment(s). Set ADTL_DEMO_KEEP=1 to keep them.\n`));
}
