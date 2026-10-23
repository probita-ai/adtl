import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AdtlInterceptors, createInterceptorServer, parseConfigText } from "@adtl/interceptors";
import { evaluatePolicy, parseConfig } from "@adtl/labels";
import {
  AdtlGateway,
  ApprovalBroker,
  GatewayConfigSchema,
  InterceptorInvoker,
  MemoryAuditLog,
  approverRoles,
  eligibleApprovers,
  type AnswerFn,
  type ApprovalEvent,
  type Notifier,
} from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer } from "../../../examples/fake-github/server.mjs";

const CONFIG = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const CALL = { sessionId: "s1", server: "github", tool: "post_comment", callHash: "sha256:abc", reason: "Untrusted session", matched: ["r1"] };
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A channel that can carry answers; the test answers by hand. */
class FakePush implements Notifier {
  events: ApprovalEvent[] = [];
  answer: AnswerFn | undefined;
  constructor(readonly name: string) {}
  async notify(e: ApprovalEvent) {
    this.events.push(e);
  }
  async listen(_r: unknown, answer: AnswerFn, signal: AbortSignal) {
    this.answer = answer;
    await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
    this.answer = undefined;
  }
  get tokens() {
    const p = this.events.find((e) => e.kind === "pending");
    return p?.kind === "pending" ? p.tokens : undefined;
  }
}

/** A channel that only sends notices, like email. */
class FakeNotice implements Notifier {
  readonly name = "notice";
  events: ApprovalEvent[] = [];
  async notify(e: ApprovalEvent) {
    this.events.push(e);
  }
}

function broker() {
  const shared = new FakePush("shared");
  const notice = new FakeNotice();
  const alice = new FakePush("ntfy:alice");
  const bob = new FakePush("ntfy:bob");
  const b = new ApprovalBroker({
    notifiers: [shared, notice],
    approverChannels: new Map([["alice", [alice]], ["bob", [bob]]]),
    timeoutMs: 5000,
  });
  return { b, shared, notice, alice, bob };
}

describe("approvals with named approvers", () => {
  it("asks only the named approvers on their own channels, plus notice-only channels", async () => {
    const { b, shared, notice, alice, bob } = broker();
    const pending = b.request({ ...CALL, approvers: ["alice"] });
    await tick();
    expect(alice.tokens).toBeDefined();
    expect(bob.events).toEqual([]);
    expect(shared.events).toEqual([]);
    expect(notice.events.map((e) => e.kind)).toEqual(["pending"]);
    expect(alice.answer!(alice.tokens!.allow)).toBe(true);
    expect(await pending).toMatchObject({ outcome: "approved", channel: "ntfy:alice", approver: "alice" });
  });

  it("ignores another approver's token, a shared token, and answers on a shared channel", async () => {
    const { b, alice, bob, shared } = broker();
    const pending = b.request({ ...CALL, approvers: ["alice", "bob"] });
    await tick();
    // Bob's token posted on Alice's channel, and the other way round.
    expect(alice.answer!(bob.tokens!.allow)).toBe(false);
    expect(bob.answer!(alice.tokens!.allow)).toBe(false);
    // A token signed for no one in particular.
    const unbound = (b as unknown as { tokens: { sign(r: unknown, d: string): string } }).tokens;
    const req = alice.events[0]!.kind === "pending" ? alice.events[0]!.request : undefined;
    expect(alice.answer!(unbound.sign(req, "allow"))).toBe(false);
    // The shared channel isn't listening for this request at all.
    expect(shared.answer).toBeUndefined();
    expect(b.answer(alice.tokens!.allow, "shared")).toBe(false);
    expect(bob.answer!(bob.tokens!.deny)).toBe(true);
    expect(await pending).toMatchObject({ outcome: "denied", approver: "bob" });
  });

  it("is undeliverable when no named approver has a channel", async () => {
    const { b } = broker();
    expect(await b.request({ ...CALL, approvers: ["carol"] })).toMatchObject({ outcome: "undeliverable" });
    expect(await b.request({ ...CALL, approvers: [] })).toMatchObject({ outcome: "undeliverable" });
  });

  it("still uses the shared channels for a request without approvers", async () => {
    const { b, shared, alice } = broker();
    const pending = b.request(CALL);
    await tick();
    expect(alice.events).toEqual([]);
    expect(shared.answer!(shared.tokens!.allow)).toBe(true);
    expect(await pending).toMatchObject({ outcome: "approved", channel: "shared" });
  });
});

describe("policy rules with approvers", () => {
  const policy = (rules: unknown[]) => parseConfig({ policy: { rules } }).policy;
  const input = { session: { integrity: "untrusted" as const, confidentiality: "public" as const, origins: [] }, server: "github", tool: "post_comment", egress: "public" as const };

  it("carries each winning ask rule's approver roles", () => {
    const d = evaluatePolicy(
      policy([
        { name: "a", when: { "tool.egress": "public" }, then: "ask", approvers: ["security-leads"] },
        { name: "b", when: { "session.integrity": "untrusted" }, then: "ask", approvers: ["maintainers", "security-leads"] },
        { name: "c", when: { tool: "github.*" }, then: "ask" },
      ]),
      input,
    );
    expect(d).toMatchObject({ decision: "ask", matched: ["a", "b", "c"], approvers: [["security-leads"], ["maintainers", "security-leads"]] });
  });

  it("drops approvers when a block wins, and rejects approvers on non-ask rules", () => {
    const d = evaluatePolicy(
      policy([
        { name: "a", when: {}, then: "ask", approvers: ["x"] },
        { name: "b", when: {}, then: "block" },
      ]),
      input,
    );
    expect(d.approvers).toBeUndefined();
    expect(() => policy([{ name: "a", when: {}, then: "block", approvers: ["x"] }])).toThrow(/approvers only applies to rules with then: ask/);
  });

  it("lets someone answer only if they are in a role of every list", () => {
    const roles = new Map([["security-leads", ["alice", "bob"]], ["maintainers", ["bob", "carol"]], ["everyone", ["*"]]]);
    expect(eligibleApprovers([["security-leads"]], roles)).toEqual(["alice", "bob"]);
    expect(eligibleApprovers([["security-leads"], ["maintainers"]], roles)).toEqual(["bob"]);
    expect(eligibleApprovers([["security-leads", "maintainers"]], roles)).toEqual(["alice", "bob", "carol"]);
    expect(eligibleApprovers([["everyone"]], roles)).toEqual([]);
    expect(eligibleApprovers([["unknown"]], roles)).toEqual([]);
  });
});

describe("approver config", () => {
  const labels = (approvers: string[]) =>
    parseConfig({ policy: { rules: [{ name: "public-write", when: { "tool.egress": "public" }, then: "ask", approvers }] } });
  const gateway = (extra: Record<string, unknown>) => GatewayConfigSchema.parse({ upstreams: { github: { command: "x" } }, ...extra });
  const roles = { leads: { members: ["alice", "bob"], tools: ["github.*"] }, all: { members: ["*"], tools: ["github.*"] } };

  it("returns each approver role's members when every member has a channel", () => {
    const cfg = gateway({ roles, approvals: { approvers: { alice: { ntfy: { topic: "a" } }, bob: { ntfy: { topic: "b" } } } } });
    expect(approverRoles(labels(["leads"]), cfg)).toEqual(new Map([["leads", ["alice", "bob"]]]));
  });

  it("names unknown roles, \"*\" members and members without a channel", () => {
    const cfg = gateway({ roles, approvals: { approvers: { alice: { ntfy: { topic: "a" } } } } });
    expect(() => approverRoles(labels(["nope"]), cfg)).toThrow(/approver role "nope", which is not under gateway.roles/);
    expect(() => approverRoles(labels(["all"]), cfg)).toThrow(/approver role "all" has member "\*"/);
    expect(() => approverRoles(labels(["leads"]), cfg)).toThrow(/approver "bob" \(role "leads"\) has no channel/);
  });
});

describe("adtl-gateway with named approvers", () => {
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

  it("asks the rule's approvers, and records who approved", async () => {
    const text = readFileSync(CONFIG, "utf8").replace("then: ask\n", "then: ask\n      approvers: [security-leads]\n");
    const config = parseConfigText(text);
    const alice = new FakePush("ntfy:alice");
    const shared = new FakePush("shared");
    const audit = new MemoryAuditLog();
    const posted: unknown[] = [];
    const gateway = new AdtlGateway({
      upstreams: new Map([["github", await linked(createFakeGithubServer({ onPost: (p: unknown) => posted.push(p) }), "gw→github")]]),
      invoker: new InterceptorInvoker(await InterceptorInvoker.discover(await linked(createInterceptorServer(new AdtlInterceptors({ config })), "gw→ic")), 5000),
      sessionId: "s",
      audit,
      approvals: new ApprovalBroker({ notifiers: [shared], approverChannels: new Map([["alice", [alice]]]), timeoutMs: 5000 }),
      approverRoles: new Map([["security-leads", ["alice"]]]),
      logger: { info: () => {}, warn: () => {} },
    });
    const agent = await linked(gateway.createServer(), "agent");
    const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;

    await call("github__read_issue", { repo: "acme/website", number: 42 });
    const result = call("github__post_comment", { repo: "acme/website", number: 42, body: "hi" });
    for (let i = 0; i < 50 && !alice.tokens; i++) await tick();
    expect(shared.events).toEqual([]);
    alice.answer!(alice.tokens!.allow);
    expect((await result).isError).toBeFalsy();
    expect(posted).toHaveLength(1);
    expect(audit.entries.at(-1)).toMatchObject({ outcome: "forwarded", decision: "ask", approval: { outcome: "approved", approver: "alice", channel: "ntfy:alice" } });
  });
});
