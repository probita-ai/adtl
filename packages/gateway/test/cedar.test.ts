import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CedarAuthorizer, clock, loadGatewayConfig, startGateway, toCedar, type AuthorizationRequest } from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));

const POLICIES = `
// Everyone may read.
permit (principal, action == Action::"tools/call", resource)
when { resource == Tool::"github.read_issue" || resource == Tool::"github.list_repos" };

// Maintainers may do anything with GitHub.
permit (principal in Group::"maintainers", action, resource);

// Anyone may comment on a repo they own (listing has no arguments yet).
permit (principal, action == Action::"tools/call", resource == Tool::"github.post_comment")
when { context.listing || (principal has repos && principal.repos.contains(context.arguments.repo)) };

// Nobody reads secrets, maintainers included.
forbid (principal, action == Action::"tools/call", resource == Tool::"github.get_file")
when { context has arguments && context.arguments has path && context.arguments.path like "*secrets*" };
`;

const ENTITIES = [
  { uid: { type: "User", id: "alice" }, attrs: {}, parents: [{ type: "Group", id: "maintainers" }] },
  { uid: { type: "User", id: "bob" }, attrs: { repos: ["bob/website"] }, parents: [] },
  { uid: { type: "Group", id: "maintainers" }, attrs: {}, parents: [] },
];

function files(policies = POLICIES, entities: unknown = ENTITIES): string {
  const dir = mkdtempSync(join(tmpdir(), "adtl-cedar-"));
  writeFileSync(join(dir, "adtl.cedar"), policies);
  writeFileSync(join(dir, "entities.json"), JSON.stringify(entities));
  return dir;
}

const call = (id: string | undefined, tool: string, args?: Record<string, unknown>): AuthorizationRequest => ({
  principal: id ? { type: "user", id } : { type: "anonymous" },
  event: "tools/call",
  server: "github",
  tool,
  ...(args ? { arguments: args } : {}),
});

describe("CedarAuthorizer", async () => {
  const dir = files();
  const authz = await CedarAuthorizer.load({ policies: "adtl.cedar", entities: "entities.json" }, (p) => join(dir, p));

  it("permits what a policy permits, through groups too, and denies the rest", () => {
    expect(authz.check(call("bob", "read_issue", {}))).toEqual({ allow: true });
    expect(authz.check(call("alice", "post_comment", { repo: "acme/website" }))).toEqual({ allow: true });
    expect(authz.check(call("bob", "get_file", { path: "README.md" }))).toEqual({ allow: false, reason: "No Cedar policy permits bob to use the tool github.get_file" });
    expect(authz.check(call(undefined, "get_file", {}))).toMatchObject({ allow: false, reason: expect.stringContaining("an anonymous caller") });
  });

  it("decides on arguments, and shows argument-dependent tools in lists", () => {
    expect(authz.check(call("bob", "post_comment", { repo: "bob/website" }))).toEqual({ allow: true });
    expect(authz.check(call("bob", "post_comment", { repo: "acme/website" }))).toMatchObject({ allow: false });
    expect(authz.check(call("bob", "post_comment"))).toEqual({ allow: true });
  });

  it("lets a forbid win over a permit, and names it", () => {
    expect(authz.check(call("alice", "get_file", { path: "README.md" }))).toEqual({ allow: true });
    expect(authz.check(call("alice", "get_file", { path: "secrets.env" }))).toEqual({
      allow: false,
      reason: "Cedar policy policy3 forbids alice to use the tool github.get_file",
    });
  });

  it("covers prompts and resources", () => {
    const p = { principal: { type: "user" as const, id: "alice" }, server: "github" };
    expect(authz.check({ ...p, event: "prompts/get", prompt: "triage" })).toEqual({ allow: true });
    expect(authz.check({ ...p, event: "resources/read", resource: "github://acme/website/README.md" })).toEqual({ allow: true });
    expect(authz.check({ ...p, principal: { type: "user", id: "bob" }, event: "prompts/get", prompt: "triage" })).toMatchObject({
      allow: false,
      reason: "No Cedar policy permits bob to use the prompt github.triage",
    });
  });

  it("refuses policies and entities that don't parse", async () => {
    await expect(CedarAuthorizer.load({ policies: "adtl.cedar" }, (p) => join(files("permit (principal action, resource);"), p))).rejects.toThrow(/gateway\.cedar\.policies/);
    await expect(CedarAuthorizer.load({ policies: "adtl.cedar", entities: "entities.json" }, (p) => join(files(POLICIES, {}), p))).rejects.toThrow(/JSON array/);
  });
});

describe("Cedar context", () => {
  it("drops nulls, stringifies fractions, and doesn't let arguments name entities", () => {
    expect(toCedar({ a: null, n: 3, f: 1.5, list: [1, null, "x"], nested: { ok: true } })).toEqual({ n: 3, f: "1.5", list: [1, "x"], nested: { ok: true } });
    expect(toCedar({ who: { __entity: { type: "User", id: "admin" } } })).toEqual({ who: '{"__entity":{"type":"User","id":"admin"}}' });
  });

  it("gives hour, minute and weekday in the configured time zone", () => {
    const t = new Date("2026-10-28T23:30:00Z");
    expect(clock(t, "UTC")).toEqual({ hour: 23, minute: 30, weekday: "Wed" });
    expect(clock(t, "Asia/Singapore")).toEqual({ hour: 7, minute: 30, weekday: "Thu" });
  });

  it("supports working-hours policies", async () => {
    const dir = files(`permit (principal, action, resource) when { context.time.hour >= 0 && context.time.hour < 24 && ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].contains(context.time.weekday) };`);
    const authz = await CedarAuthorizer.load({ policies: "adtl.cedar", timeZone: "UTC" }, (p) => join(dir, p));
    expect(authz.check(call("bob", "post_comment", {}))).toEqual({ allow: true });
  });
});

describe("adtl-gateway with cedar", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((f) => f()));
  });

  function writeConfig(dir: string, gateway: string): string {
    const path = join(dir, "adtl.yaml");
    const labels = readFileSync(EXAMPLE, "utf8").replace(/gateway:[\s\S]*$/, "");
    writeFileSync(path, `${labels}gateway:\n  upstreams:\n    github: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE_GITHUB)}] }\n${gateway}`);
    return path;
  }

  async function start(gateway: string) {
    const dir = files();
    const started = await startGateway(await loadGatewayConfig(writeConfig(dir, gateway)), { logger: { info: () => {}, warn: () => {} } });
    cleanup.push(() => started.close());
    const [a, b] = InMemoryTransport.createLinkedPair();
    await started.gateway.createServer().connect(b);
    const agent = new Client({ name: "agent", version: "0.0.0" });
    await agent.connect(a);
    cleanup.push(() => agent.close());
    return {
      call: (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>,
      tools: async () => (await agent.listTools()).tools.map((t) => t.name).sort(),
    };
  }

  it("hides denied tools and stops denied calls before the policy", async () => {
    const { call, tools } = await start("  principal: { id: bob }\n  cedar: { policies: adtl.cedar, entities: entities.json }\n");
    expect(await tools()).toEqual(["github__list_repos", "github__post_comment", "github__read_issue"]);
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("No Cedar policy permits bob to use the tool github.post_comment") });
    expect((await call("github__post_comment", { repo: "bob/website", number: 1, body: "hi" })).isError).toBeFalsy();
  });

  it("requires every authorizer to allow when roles are set too", async () => {
    const { call } = await start('  principal: { id: alice }\n  roles:\n    readers: { members: ["*"], tools: ["github.read_*"] }\n  cedar: { policies: adtl.cedar, entities: entities.json }\n');
    expect((await call("github__read_issue", { repo: "acme/website", number: 42 })).isError).toBeFalsy();
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("No role lets alice") });
  });

  it("fails startup on a missing policy file", async () => {
    const dir = files();
    await expect(startGateway(await loadGatewayConfig(writeConfig(dir, "  cedar: { policies: missing.cedar }\n")))).rejects.toThrow(/missing\.cedar/);
  });
});
