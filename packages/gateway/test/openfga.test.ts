import { describe, expect, it } from "vitest";
import { GatewayConfigSchema, OpenFgaAuthorizer, OpenFgaConfigSchema, authorize, gatewayAuthorizers, type AuthorizationRequest } from "../src/index.js";

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: { tuple_key: { user: string; relation: string; object: string }; authorization_model_id?: string };
}

/** A stand-in for OpenFGA's check endpoint: allows the tuples listed, as `user|relation|object`. */
function fakeFga(tuples: string[], status = 200) {
  const sent: Sent[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Sent["body"];
    sent.push({ url, headers: init.headers as Record<string, string>, body });
    const { user, relation, object } = body.tuple_key;
    return new Response(JSON.stringify({ allowed: tuples.includes(`${user}|${relation}|${object}`) }), { status });
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

const config = (over: Record<string, unknown> = {}) => OpenFgaConfigSchema.parse({ url: "http://fga.test/", storeId: "s1", ...over });
const call = (id: string | undefined, tool: string, args?: Record<string, unknown>): AuthorizationRequest => ({
  principal: id ? { type: "user", id } : { type: "anonymous" },
  event: "tools/call",
  server: "github",
  tool,
  ...(args ? { arguments: args } : {}),
});

describe("OpenFgaAuthorizer", () => {
  it("checks user, relation and object, and names what's missing in a denial", async () => {
    const f = fakeFga(["user:alice|can_use|tool:github.read_issue"]);
    const authz = new OpenFgaAuthorizer(config({ modelId: "m1", token: "t" }), f.fetchFn);
    expect(await authz.check(call("alice", "read_issue", {}))).toEqual({ allow: true });
    expect(f.sent[0]).toMatchObject({ url: "http://fga.test/stores/s1/check", body: { authorization_model_id: "m1" } });
    expect(f.sent[0]!.headers.authorization).toBe("Bearer t");
    expect(await authz.check(call("bob", "read_issue", {}))).toEqual({ allow: false, reason: "OpenFGA: user:bob has no can_use on tool:github.read_issue" });
    expect(await authz.check(call(undefined, "read_issue", {}))).toMatchObject({ allow: false, reason: expect.stringContaining("user:anonymous") });
  });

  it("decides per resource from a tool rule's arguments", async () => {
    const f = fakeFga(["user:alice|can_comment|repo:acme%2Fwebsite"]);
    const tools = { "github.add_issue_comment": { relation: "can_comment", object: "repo:{owner}/{repo}" } };
    const authz = new OpenFgaAuthorizer(config({ tools }), f.fetchFn);
    expect(await authz.check(call("alice", "add_issue_comment", { owner: "acme", repo: "website" }))).toEqual({ allow: true });
    expect((await authz.check(call("alice", "add_issue_comment", { owner: "acme", repo: "internal" }))).allow).toBe(false);
  });

  it("denies when an argument is missing or not a value, and keeps such tools in lists", async () => {
    const f = fakeFga([]);
    const authz = new OpenFgaAuthorizer(config({ tools: { "github.t": { object: "repo:{repo}" } } }), f.fetchFn);
    expect(await authz.check(call("alice", "t", {}))).toEqual({ allow: false, reason: 'openfga: t has no usable argument "repo"' });
    expect((await authz.check(call("alice", "t", { repo: { nested: true } }))).allow).toBe(false);
    expect(f.sent).toHaveLength(0);
    expect(await authz.check(call("alice", "t"))).toEqual({ allow: true });
  });

  it("encodes ids OpenFGA can't hold", async () => {
    const f = fakeFga([]);
    const authz = new OpenFgaAuthorizer(config(), f.fetchFn);
    await authz.check({ principal: { type: "service", id: "ci@acme" }, event: "resources/read", server: "docs", resource: "file:///a b.md" });
    expect(f.sent[0]!.body.tuple_key).toMatchObject({ user: "service:ci%40acme", object: "resource:file%3A%2F%2F%2Fa%20b.md" });
    await authz.check({ principal: { type: "user", id: "a" }, event: "resources/read", server: "docs", resource: `file:///${"x".repeat(400)}` });
    expect(f.sent[1]!.body.tuple_key.object).toMatch(/^resource:sha256-[0-9a-f]{64}$/);
  });

  it("fails closed when OpenFGA errors or can't be reached", async () => {
    const down = new OpenFgaAuthorizer(config(), fakeFga(["user:alice|can_use|tool:github.t"], 500).fetchFn);
    expect(await authorize(down, call("alice", "t", {}))).toEqual({ by: "openfga", reason: "openfga failed: OpenFGA answered 500" });
    const gone = new OpenFgaAuthorizer(config(), (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch);
    expect(await authorize(gone, call("alice", "t", {}))).toMatchObject({ by: "openfga", reason: expect.stringContaining("connection refused") });
  });
});

describe("gateway.openfga config", () => {
  const gateway = (openfga: unknown) => ({ upstreams: { a: { command: "x" } }, openfga });

  it("expands ${VAR} and joins the other authorizers", async () => {
    const cfg = GatewayConfigSchema.parse(gateway({ url: "${FGA_URL}", storeId: "${FGA_STORE}" }));
    const [authz] = await gatewayAuthorizers(cfg, "/tmp", { FGA_URL: "http://fga.test", FGA_STORE: "s1" });
    expect(authz?.name).toBe("openfga");
    await expect(gatewayAuthorizers(cfg, "/tmp", {})).rejects.toThrow(/FGA_URL/);
  });

  it("rejects objects without a type and unknown keys", () => {
    expect(() => GatewayConfigSchema.parse(gateway({ url: "u", storeId: "s", tools: { "a.b": { object: "nope" } } }))).toThrow(/type:id/);
    expect(() => GatewayConfigSchema.parse(gateway({ url: "u", storeId: "s", retries: 2 }))).toThrow();
  });
});
