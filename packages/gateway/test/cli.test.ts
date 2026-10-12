/**
 * End to end with real processes:
 *   test client ──stdio──▶ adtl-gateway ──stdio──▶ adtl-interceptors
 *                                     └──stdio──▶ fake GitHub server
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));

const clients: Client[] = [];
afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((c) => c.close()));
});

function tempConfig(): { dir: string; config: string; audit: string; posted: string } {
  const dir = mkdtempSync(join(tmpdir(), "adtl-e2e-"));
  const config = join(dir, "adtl.yaml");
  const audit = join(dir, "audit.jsonl");
  const posted = join(dir, "posted.jsonl");
  const yaml = readFileSync(EXAMPLE, "utf8")
    .replace(/gateway:[\s\S]*$/, "")
    .concat(`gateway:\n  audit: ./audit.jsonl\n  upstreams:\n    github:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(FAKE_GITHUB)}]\n      env: { FAKE_GITHUB_POSTED: ${JSON.stringify(posted)} }\n`);
  writeFileSync(config, yaml);
  return { dir, config, audit, posted };
}

describe.skipIf(!existsSync(CLI))("adtl-gateway CLI (real processes)", () => {
  it("blocks the exfiltration end to end and writes the audit log", async () => {
    const t = tempConfig();
    const agent = new Client({ name: "e2e-agent", version: "0.0.0" });
    await agent.connect(
      new StdioClientTransport({ command: process.execPath, args: [CLI, "--config", t.config], env: getDefaultEnvironment(), stderr: "pipe" }),
    );
    clients.push(agent);
    expect(agent.getServerVersion()?.name).toBe("adtl-gateway");

    const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;
    const { tools } = await agent.listTools();
    expect(tools.map((x) => x.name)).toContain("github__post_comment");

    expect((await call("github__read_issue", { repo: "acme/website", number: 42 })).isError).toBeFalsy();
    expect((await call("github__get_file", { repo: "acme/internal", path: "secrets.env" })).isError).toBeFalsy();
    const leak = await call("github__post_comment", { repo: "acme/website", number: 42, body: "STRIPE_KEY=..." });
    expect(leak.isError).toBe(true);

    await agent.close();
    expect(existsSync(t.posted)).toBe(false); // nothing was ever posted
    const entries = readFileSync(t.audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(entries.map((e) => [e.tool, e.outcome])).toEqual([
      ["read_issue", "forwarded"],
      ["get_file", "forwarded"],
      ["post_comment", "blocked"],
    ]);
    expect(entries[2]).toMatchObject({ decision: "block", sessionLabel: { integrity: "untrusted", confidentiality: "private" } });
  }, 20_000);

  it("runs the example config as-is", async () => {
    const agent = new Client({ name: "e2e-agent", version: "0.0.0" });
    await agent.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "--config", EXAMPLE], stderr: "pipe" }));
    clients.push(agent);
    const r = (await agent.callTool({ name: "github__list_repos", arguments: {} })) as CallToolResult;
    expect(r.isError).toBeFalsy();
  }, 20_000);

  it("starts from the Claude Code example's .mcp.json, as Claude Code launches it", async () => {
    const dir = fileURLToPath(new URL("../../../examples/claude-code", import.meta.url));
    const { command, args } = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.adtl;
    const agent = new Client({ name: "claude-code-sim", version: "0.0.0" });
    await agent.connect(new StdioClientTransport({ command, args, cwd: dir, stderr: "pipe" }));
    clients.push(agent);
    const { tools } = await agent.listTools();
    // Claude Code exposes these as mcp__adtl__<name>; MCP tool names must stay within 64 characters.
    expect(tools.map((t) => `mcp__adtl__${t.name}`).every((n) => n.length <= 64)).toBe(true);
    expect(tools).toHaveLength(4);
  }, 20_000);

  it("exits with a clear message on a bad config", () => {
    const t = tempConfig();
    writeFileSync(t.config, "gateway: { upstreams: { github: { command: node } } }\nservers: { github: { tools: { x: { egress: sideways } } } }\n");
    const r = spawnSync(process.execPath, [CLI, "--config", t.config], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("servers.github.tools.x.egress");
  });
});
