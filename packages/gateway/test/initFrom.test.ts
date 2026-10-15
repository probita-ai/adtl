import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseDocument } from "yaml";
import { GATEWAY_VERSION, NEW_CONFIG, importMcpServers, isGatewayEntry, loadGatewayConfig, runInit, upstreamId } from "../src/index.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));

const CLIENT = {
  mcpServers: {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" } },
    "docs.api": { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
    legacy: { type: "sse", url: "https://old.example.com/sse" },
  },
  otherSetting: true,
};

describe("isGatewayEntry", () => {
  it("recognizes the gateway however it's started", () => {
    expect(isGatewayEntry({ command: "npx", args: ["-y", "@adtl/gateway@0.3.1", "--config", "adtl.yaml"] })).toBe(true);
    expect(isGatewayEntry({ command: "adtl-gateway", args: ["--config", "a.yaml"] })).toBe(true);
    expect(isGatewayEntry({ command: "node", args: ["../../packages/gateway/dist/cli.js", "--config", "../adtl.yaml"] })).toBe(true);
    expect(isGatewayEntry({ command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] })).toBe(false);
  });
});

describe("upstreamId", () => {
  it("makes names valid and unique", () => {
    const taken = new Set(["github"]);
    expect(upstreamId("github", taken)).toBe("github-2");
    expect(upstreamId("claude_ai Gmail", taken)).toBe("claude-ai-Gmail");
    expect(upstreamId("___", taken)).toBe("server");
  });
});

describe("importMcpServers", () => {
  it("moves stdio and HTTP servers into gateway.upstreams and leaves SSE in the client", () => {
    const doc = parseDocument(NEW_CONFIG);
    const r = importMcpServers(JSON.stringify(CLIENT), "/proj/.mcp.json", doc, "/proj/adtl.yaml");
    expect(r.imported).toEqual([
      { name: "github", id: "github" },
      { name: "docs.api", id: "docs-api" },
    ]);
    expect(r.skipped).toEqual([{ name: "legacy", reason: expect.stringContaining("SSE") }]);
    expect(doc.toJS().gateway.upstreams).toEqual({
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" } },
      "docs-api": { url: "https://docs.example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } },
    });
    const client = JSON.parse(r.text);
    expect(client.otherSetting).toBe(true);
    expect(Object.keys(client.mcpServers)).toEqual(["legacy", "adtl"]);
    expect(client.mcpServers.adtl).toEqual({ command: "npx", args: ["-y", `@adtl/gateway@${GATEWAY_VERSION}`, "--config", "adtl.yaml"] });
  });

  it("sets cwd when adtl.yaml lives elsewhere, and points the client at it", () => {
    const doc = parseDocument(NEW_CONFIG);
    const r = importMcpServers(JSON.stringify({ mcpServers: { s: { command: "node", args: ["server.js"] } } }), "/proj/.mcp.json", doc, "/home/me/adtl/adtl.yaml");
    expect(doc.toJS().gateway.upstreams.s).toEqual({ command: "node", args: ["server.js"], cwd: "../../../proj" });
    expect(JSON.parse(r.text).mcpServers.adtl.args).toContain("../home/me/adtl/adtl.yaml");
  });

  it("never changes upstreams already in adtl.yaml, and keeps an existing gateway entry", () => {
    const doc = parseDocument("gateway:\n  upstreams:\n    github:\n      command: my-github # mine\n");
    const client = { mcpServers: { github: { command: "other" }, gw: { command: "adtl-gateway", args: ["-c", "adtl.yaml"] } } };
    const r = importMcpServers(JSON.stringify(client), "/p/.mcp.json", doc, "/p/adtl.yaml");
    expect(r.kept).toEqual([{ name: "github", id: "github" }]);
    expect(doc.toString()).toContain("command: my-github # mine");
    expect(Object.keys(JSON.parse(r.text).mcpServers)).toEqual(["gw"]);
  });

  it("changes nothing when there is nothing to import", () => {
    const text = JSON.stringify({ mcpServers: { gw: { command: "adtl-gateway" } } });
    const r = importMcpServers(text, "/p/.mcp.json", parseDocument(NEW_CONFIG), "/p/adtl.yaml");
    expect(r).toMatchObject({ imported: [], changed: false, text });
  });

  it("rejects files without mcpServers", () => {
    expect(() => importMcpServers("{}", "/p/x.json", parseDocument(NEW_CONFIG), "/p/adtl.yaml")).toThrow(/mcpServers/);
    expect(() => importMcpServers("nope", "/p/x.json", parseDocument(NEW_CONFIG), "/p/adtl.yaml")).toThrow(/not valid JSON/);
  });
});

function project(): { dir: string; mcp: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "adtl-from-"));
  const mcp = join(dir, ".mcp.json");
  writeFileSync(
    mcp,
    JSON.stringify({ mcpServers: { github: { command: process.execPath, args: [FAKE_GITHUB] }, legacy: { type: "sse", url: "https://x/sse" } } }, null, 2),
  );
  return { dir, mcp, config: join(dir, "adtl.yaml") };
}

describe("runInit --from (real upstream process)", () => {
  it("creates adtl.yaml, drafts rules and rewrites the client config only with write", async () => {
    const p = project();
    const before = readFileSync(p.mcp, "utf8");
    const dry = await runInit({ path: p.config, from: p.mcp });
    expect(dry.created).toBe(true);
    expect(existsSync(p.config)).toBe(false);
    expect(readFileSync(p.mcp, "utf8")).toBe(before);
    expect(dry.reports).toEqual([expect.objectContaining({ id: "github", preset: "github" })]);

    await runInit({ path: p.config, from: p.mcp, write: true });
    expect(readFileSync(p.config, "utf8")).toBe(dry.text);
    expect(readFileSync(`${p.mcp}.bak`, "utf8")).toBe(before);
    expect(Object.keys(JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers)).toEqual(["legacy", "adtl"]);
    const loaded = await loadGatewayConfig(p.config);
    expect(Object.keys(loaded.gateway.upstreams)).toEqual(["github"]);
    expect(loaded.labels.servers.github?.tools.post_comment?.egress).toBe("public");

    const again = await runInit({ path: p.config, from: p.mcp, write: true });
    expect(again.mcp).toMatchObject({ imported: [], changed: false });
    expect(readFileSync(p.config, "utf8")).toBe(dry.text);
  });

  it("adds to an existing adtl.yaml, keeping a backup", async () => {
    const p = project();
    mkdirSync(join(p.dir, "sub"));
    const config = join(p.dir, "sub", "adtl.yaml");
    const original = "# mine\npolicy:\n  default: allow\ngateway:\n  upstreams: {}\n";
    writeFileSync(config, original);
    await runInit({ path: config, from: p.mcp, write: true });
    expect(readFileSync(`${config}.bak`, "utf8")).toBe(original);
    const loaded = await loadGatewayConfig(config);
    expect(loaded.gateway.upstreams.github).toMatchObject({ cwd: ".." });
    expect(JSON.parse(readFileSync(p.mcp, "utf8")).mcpServers.adtl.args).toContain("sub/adtl.yaml");
  });

  it("still needs the config to exist without --from", async () => {
    await expect(runInit({ path: join(tmpdir(), "adtl-missing", "adtl.yaml") })).rejects.toThrow(/Cannot read config file/);
  });
});

describe.skipIf(!existsSync(CLI))("adtl-gateway init --from (CLI)", () => {
  it("prints both files and a summary, and writes nothing", () => {
    const p = project();
    const r = spawnSync(process.execPath, [CLI, "init", "-c", p.config, "--from", p.mcp], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("gateway:\n  upstreams:\n    github:");
    expect(r.stdout).toContain(`#         "@adtl/gateway@${GATEWAY_VERSION}",`);
    expect(r.stderr).toContain("imported github from");
    expect(r.stderr).toContain("legacy: left in");
    expect(r.stderr).toContain("would create");
    expect(existsSync(p.config)).toBe(false);
  });

  it("rejects --from outside init", () => {
    const r = spawnSync(process.execPath, [CLI, "--from", "x", "-c", "y"], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown argument: --from");
  });
});
