import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AdtlInterceptors, createInterceptorServer, parseConfigText } from "@adtl/interceptors";
import {
  AdtlGateway,
  GATEWAY_DECISION_KEY,
  InterceptorInvoker,
  MemoryAuditLog,
  type AuthorizationRequest,
  type Authorizer,
  type Principal,
} from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer } from "../../../examples/fake-github/server.mjs";

const CONFIG = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));

const toClose: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.allSettled(toClose.splice(0).map((c) => c.close()));
});

async function linked(server: { connect(t: unknown): Promise<void> }, name: string): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(a);
  toClose.push(client);
  return client;
}

/** Lets through only the tools in `allowed`; records every request it sees. */
class ToolList implements Authorizer {
  readonly name = "tool-list";
  readonly seen: AuthorizationRequest[] = [];
  constructor(private readonly allowed: string[]) {}
  check(r: AuthorizationRequest) {
    this.seen.push(r);
    const what = r.tool ?? r.prompt ?? r.resource ?? "";
    return this.allowed.includes(what) ? { allow: true as const } : { allow: false as const, reason: `${r.principal.id ?? "anonymous"} may not use ${what}` };
  }
}

async function setup(authorizer: Authorizer, opts: { mode?: "audit"; principal?: Principal } = {}) {
  const posted: unknown[] = [];
  const core = new AdtlInterceptors({ config: parseConfigText(readFileSync(CONFIG, "utf8")) });
  let policyCalls = 0;
  const invoke = core.invoke.bind(core);
  core.invoke = (p) => {
    if (p.name === "adtl.policy") policyCalls++;
    return invoke(p);
  };
  const audit = new MemoryAuditLog();
  const gateway = new AdtlGateway({
    upstreams: new Map([["github", await linked(createFakeGithubServer({ onPost: (p: unknown) => posted.push(p) }), "gw→github")]]),
    invoker: new InterceptorInvoker(await InterceptorInvoker.discover(await linked(createInterceptorServer(core), "gw→interceptors")), 5000, opts.mode),
    sessionId: "s",
    audit,
    authorizer,
    ...(opts.principal ? { principal: opts.principal } : {}),
    logger: { info: () => {}, warn: () => {} },
  });
  const agent = await linked(gateway.createServer(), "agent");
  const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { agent, call, posted, audit, policyCalls: () => policyCalls };
}

describe("authorizer", () => {
  it("stops a call the caller may not make, before the policy runs", async () => {
    const { call, posted, audit, policyCalls } = await setup(new ToolList(["read_issue"]));
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.isError).toBe(true);
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("anonymous may not use post_comment") });
    expect(r._meta?.[GATEWAY_DECISION_KEY]).toMatchObject({ decision: "block", authorizer: "tool-list" });
    expect(posted).toHaveLength(0);
    expect(policyCalls()).toBe(0);
    expect(audit.entries[0]).toMatchObject({ outcome: "blocked", decision: "block", denied: { by: "tool-list", reason: "anonymous may not use post_comment" } });
  });

  it("leaves an allowed call to the policy", async () => {
    const { call, posted } = await setup(new ToolList(["read_issue", "post_comment"]));
    await call("github__read_issue", { repo: "acme/website", number: 42 });
    // Allowed by the authorizer, but the session is now untrusted: the policy asks, and without approvals that blocks.
    const r = await call("github__post_comment", { repo: "acme/website", number: 42, body: "hi" });
    expect(r.isError).toBe(true);
    expect(posted).toHaveLength(0);
  });

  it("passes the principal, server, tool and arguments", async () => {
    const authz = new ToolList(["list_repos"]);
    const { call } = await setup(authz, { principal: { type: "user", id: "alice", claims: { team: "web" } } });
    await call("github__list_repos", {});
    expect(authz.seen).toEqual([
      { principal: { type: "user", id: "alice", claims: { team: "web" } }, event: "tools/call", server: "github", tool: "list_repos", arguments: {} },
    ]);
  });

  it("denies when the authorizer fails", async () => {
    const broken: Authorizer = { name: "broken", check: () => Promise.reject(new Error("policy store unreachable")) };
    const { call, posted } = await setup(broken);
    const r = await call("github__list_repos", {});
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("broken failed: policy store unreachable") });
    expect(posted).toHaveLength(0);
  });

  it("only logs denials in audit mode", async () => {
    const { call, posted, audit } = await setup(new ToolList([]), { mode: "audit" });
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.isError).toBeFalsy();
    expect(posted).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ outcome: "forwarded", mode: "audit", denied: { by: "tool-list" } });
  });

  it("covers resources and prompts", async () => {
    const authz = new ToolList([]);
    const { agent, audit } = await setup(authz);
    await expect(agent.readResource({ uri: "github://acme/website/README.md" })).rejects.toThrow(/may not use github:\/\/acme\/website\/README.md/);
    await expect(agent.getPrompt({ name: "github__triage_issue", arguments: { number: "1" } })).rejects.toThrow(/may not use triage_issue/);
    expect(authz.seen.map((r) => [r.event, r.resource ?? r.prompt])).toEqual([
      ["resources/read", "github://acme/website/README.md"],
      ["prompts/get", "triage_issue"],
    ]);
    expect(authz.seen[1]?.arguments).toEqual({ number: "1" });
    expect(audit.entries.map((e) => e.outcome)).toEqual(["blocked", "blocked"]);
  });

  it("lists only the tools the caller may use, and still checks a call to a hidden one", async () => {
    const { agent, call } = await setup(new ToolList(["read_issue", "list_repos"]));
    expect((await agent.listTools()).tools.map((t) => t.name).sort()).toEqual(["github__list_repos", "github__read_issue"]);
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.content[0]).toMatchObject({ text: expect.stringContaining("may not use post_comment") });
  });

  it("hides prompts and resources the caller may not use", async () => {
    const { agent } = await setup(new ToolList(["github://acme/website/README.md"]));
    expect((await agent.listResources()).resources.map((r) => r.uri)).toEqual(["github://acme/website/README.md"]);
    expect((await agent.listPrompts()).prompts).toEqual([]);
    const { agent: other } = await setup(new ToolList(["triage_issue"]));
    expect((await other.listPrompts()).prompts.map((p) => p.name)).toEqual(["github__triage_issue"]);
    expect((await other.listResources()).resources).toEqual([]);
  });

  it("hides nothing in audit mode", async () => {
    const { agent } = await setup(new ToolList([]), { mode: "audit" });
    expect((await agent.listTools()).tools).toHaveLength(4);
  });
});

