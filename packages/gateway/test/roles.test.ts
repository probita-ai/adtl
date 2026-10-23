import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RoleAuthorizer, gatewayPrincipal, loadGatewayConfig, startGateway, type AuthorizationRequest, type RoleConfig } from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));

const ROLES: Record<string, RoleConfig> = {
  maintainers: { members: ["alice"], tools: ["github.*"], prompts: ["github.*"], resources: [] },
  readers: { members: ["*"], tools: ["github.read_*", "github.get_*"], prompts: [], resources: ["github://acme/website/*"] },
};

const tool = (id: string | undefined, name: string): AuthorizationRequest => ({
  principal: id ? { type: "user", id } : { type: "anonymous" },
  event: "tools/call",
  server: "github",
  tool: name,
});

describe("RoleAuthorizer", () => {
  const authz = new RoleAuthorizer(ROLES);

  it("allows what a member's roles grant, and denies the rest", () => {
    expect(authz.check(tool("alice", "post_comment"))).toEqual({ allow: true });
    expect(authz.check(tool("bob", "read_issue"))).toEqual({ allow: true });
    expect(authz.check(tool("bob", "post_comment"))).toEqual({ allow: false, reason: "No role lets bob use the tool github.post_comment" });
  });

  it("gives an anonymous caller only the roles open to everyone", () => {
    expect(authz.check(tool(undefined, "get_file"))).toEqual({ allow: true });
    expect(authz.check(tool(undefined, "post_comment"))).toMatchObject({ allow: false, reason: expect.stringContaining("an anonymous caller") });
  });

  it("matches the whole server.tool name, as policy rules do", () => {
    expect(authz.check({ ...tool("bob", "read_issue"), server: "gitlab" })).toMatchObject({ allow: false });
    expect(authz.check(tool("bob", "xread_issue"))).toMatchObject({ allow: false });
  });

  it("covers prompts and resources", () => {
    const prompt = { principal: { type: "user" as const, id: "bob" }, event: "prompts/get" as const, server: "github", prompt: "triage_issue" };
    expect(authz.check(prompt)).toEqual({ allow: false, reason: "No role lets bob use the prompt github.triage_issue" });
    expect(authz.check({ ...prompt, principal: { type: "user", id: "alice" } })).toEqual({ allow: true });
    const resource = { principal: { type: "anonymous" as const }, event: "resources/read" as const, server: "github" };
    expect(authz.check({ ...resource, resource: "github://acme/website/README.md" })).toEqual({ allow: true });
    expect(authz.check({ ...resource, resource: "github://acme/internal/secrets.env" })).toMatchObject({ allow: false });
  });
});

function writeConfig(gateway: string): string {
  const dir = mkdtempSync(join(tmpdir(), "adtl-roles-"));
  const path = join(dir, "adtl.yaml");
  const labels = readFileSync(EXAMPLE, "utf8").replace(/gateway:[\s\S]*$/, "");
  writeFileSync(path, `${labels}gateway:\n  upstreams:\n    github: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE_GITHUB)}] }\n${gateway}`);
  return path;
}

describe("gateway.roles and gateway.principal config", () => {
  it("rejects patterns without a server, empty members, roles that grant nothing and unknown keys", async () => {
    const bad = async (roles: string) => loadGatewayConfig(writeConfig(`  roles:\n${roles}`));
    await expect(bad("    r: { members: [a], tools: [read_issue] }\n")).rejects.toThrow(/gateway\.roles\.r\.tools\.0: Use "server\.name"/);
    await expect(bad("    r: { members: [], tools: [github.*] }\n")).rejects.toThrow(/at least one member/);
    await expect(bad("    r: { members: [a] }\n")).rejects.toThrow(/must grant at least one of tools, prompts or resources/);
    await expect(bad("    r: { members: [a], tools: [github.*], admin: true }\n")).rejects.toThrow(/Unrecognized key/);
    await expect(loadGatewayConfig(writeConfig("  roles: {}\n"))).rejects.toThrow(/at least one role/);
  });

  it("expands ${VAR} in principal.id, and refuses an empty one", async () => {
    const c = await loadGatewayConfig(writeConfig('  principal: { id: "${ADTL_USER}" }\n'));
    expect(gatewayPrincipal(c.gateway, { ADTL_USER: "alice" })).toEqual({ type: "user", id: "alice" });
    expect(() => gatewayPrincipal(c.gateway, {})).toThrow(/ADTL_USER/);
    expect(() => gatewayPrincipal(c.gateway, { ADTL_USER: " " })).toThrow(/empty/);
  });
});

describe("adtl-gateway with roles", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((f) => f()));
  });

  async function start(gateway: string, env: NodeJS.ProcessEnv) {
    const warnings: string[] = [];
    const started = await startGateway(await loadGatewayConfig(writeConfig(gateway)), { env, logger: { info: () => {}, warn: (m) => warnings.push(m) } });
    cleanup.push(() => started.close());
    const [a, b] = InMemoryTransport.createLinkedPair();
    await started.gateway.createServer().connect(b);
    const agent = new Client({ name: "agent", version: "0.0.0" });
    await agent.connect(a);
    cleanup.push(() => agent.close());
    return {
      call: (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>,
      tools: async () => (await agent.listTools()).tools.map((t) => t.name).sort(),
      warnings,
    };
  }

  const ROLES_YAML = '  roles:\n    maintainers: { members: [alice], tools: ["github.*"] }\n    readers: { members: ["*"], tools: ["github.read_*", "github.list_*"] }\n';

  it("lets the configured principal use what its roles grant", async () => {
    const { call, tools } = await start(`  principal: { id: "\${ADTL_USER}" }\n${ROLES_YAML}`, { ...process.env, ADTL_USER: "alice" });
    expect(await tools()).toHaveLength(4);
    expect((await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" })).isError).toBeFalsy();
  });

  it("denies other callers, and warns when roles are set without a principal", async () => {
    const { call, tools, warnings } = await start(ROLES_YAML, process.env);
    expect(await tools()).toEqual(["github__list_repos", "github__read_issue"]);
    expect((await call("github__list_repos", {})).isError).toBeFalsy();
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("No role lets an anonymous caller use the tool github.post_comment") });
    expect(warnings).toContainEqual(expect.stringContaining("gateway.principal is not"));
  });
});
