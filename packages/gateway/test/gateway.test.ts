import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AdtlInterceptors, createInterceptorServer, parseConfigText } from "@adtl/interceptors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AdtlGateway,
  ApprovalBroker,
  GATEWAY_DECISION_KEY,
  InterceptorInvoker,
  MemoryAuditLog,
  type ApprovalEvent,
  type AnswerFn,
  type Notifier,
} from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer, SECRET_FILE } from "../../../examples/fake-github/server.mjs";

const CONFIG = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const TRUST_KEY = "io.modelcontextprotocol/trust-annotations";

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

/** A push channel whose "human" answers every request the same way (or never). */
class AutoAnswer implements Notifier {
  readonly name = "auto";
  events: ApprovalEvent[] = [];
  private answer: AnswerFn | undefined;
  constructor(private readonly decision: "allow" | "deny" | "never") {}
  async listen(_r: unknown, answer: AnswerFn, signal: AbortSignal) {
    this.answer = answer;
    await new Promise<void>((r) => signal.addEventListener("abort", () => r()));
  }
  async notify(e: ApprovalEvent) {
    this.events.push(e);
    if (e.kind === "pending" && this.decision !== "never") setTimeout(() => this.answer!(e.tokens[this.decision as "allow" | "deny"]), 5);
  }
}

async function setup(opts: { interceptorsServer?: { connect(t: unknown): Promise<void> }; mode?: "audit"; approvals?: ApprovalBroker } = {}) {
  const posted: unknown[] = [];
  const config = parseConfigText(readFileSync(CONFIG, "utf8"));
  const icClient = await linked(opts.interceptorsServer ?? createInterceptorServer(new AdtlInterceptors({ config })), "gw→interceptors");
  const github = await linked(createFakeGithubServer({ onPost: (p: unknown) => posted.push(p) }), "gw→github");
  const audit = new MemoryAuditLog();
  const gateway = new AdtlGateway({
    upstreams: new Map([["github", github]]),
    invoker: new InterceptorInvoker(await InterceptorInvoker.discover(icClient), 5000, opts.mode),
    sessionId: "test-session",
    audit,
    ...(opts.approvals ? { approvals: opts.approvals } : {}),
    logger: { info: () => {}, warn: () => {} },
  });
  const agent = await linked(gateway.createServer(), "agent");
  const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { agent, call, posted, audit };
}

const textOf = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("adtl-gateway", () => {
  it("exposes upstream tools as <server>__<tool>, keeping schemas and annotations", async () => {
    const { agent } = await setup();
    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["github__get_file", "github__list_repos", "github__post_comment", "github__read_issue"]);
    const read = tools.find((t) => t.name === "github__read_issue")!;
    expect(read.annotations).toMatchObject({ openWorldHint: true });
    expect(read.inputSchema.properties).toHaveProperty("number");
  });

  it("stops the GitHub-issue exfiltration attack", async () => {
    const { call, posted, audit } = await setup();
    await call("github__list_repos", {});

    // A harmless comment before anything untrusted is read goes through.
    const ok = await call("github__post_comment", { repo: "acme/website", number: 1, body: "Thanks!" });
    expect(ok.isError).toBeFalsy();
    expect(posted).toHaveLength(1);

    // The agent reads the injected issue: the result arrives labeled untrusted.
    const issue = await call("github__read_issue", { repo: "acme/website", number: 42 });
    expect(issue._meta?.[TRUST_KEY]).toMatchObject({ untrusted: true });

    // Now a public write needs approval (blocked in v0.1).
    const ask = await call("github__post_comment", { repo: "acme/website", number: 42, body: "hello" });
    expect(ask.isError).toBe(true);
    expect(textOf(ask)).toContain("needs a human's approval");
    expect(ask._meta?.[GATEWAY_DECISION_KEY]).toMatchObject({ decision: "ask", interceptor: "adtl.policy" });

    // The agent follows the injection and reads the secret file...
    const secret = await call("github__get_file", { repo: "acme/internal", path: "secrets.env" });
    expect(textOf(secret)).toContain(SECRET_FILE.trim());
    expect(secret._meta?.[TRUST_KEY]).toMatchObject({ sensitive: true });

    // ...and tries to post it. Blocked outright, and nothing reached the upstream.
    const leak = await call("github__post_comment", { repo: "acme/website", number: 42, body: SECRET_FILE });
    expect(leak.isError).toBe(true);
    expect(textOf(leak)).toContain("ADTL blocked this call: Private data must not reach a public tool");
    expect(posted).toHaveLength(1);

    expect(audit.entries.map((e) => [e.tool, e.outcome, e.decision])).toEqual([
      ["list_repos", "forwarded", "allow"],
      ["post_comment", "forwarded", "allow"],
      ["read_issue", "forwarded", "allow"],
      ["post_comment", "blocked", "ask"],
      ["get_file", "forwarded", "allow"],
      ["post_comment", "blocked", "block"],
    ]);
    // The audit log never contains arguments or results.
    expect(JSON.stringify(audit.entries)).not.toContain("hunter2");
  });

  it("returns an error result for unknown tools", async () => {
    const { call } = await setup();
    const r = await call("github__nope", {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Unknown tool");
  });

  it("fails closed when an interceptor fails", async () => {
    // An interceptor server whose adtl.policy always errors.
    const config = parseConfigText(readFileSync(CONFIG, "utf8"));
    const core = new AdtlInterceptors({ config });
    const original = core.invoke.bind(core);
    core.invoke = (p) => {
      if (p.name === "adtl.policy") throw new Error("boom");
      return original(p);
    };
    const { call, posted } = await setup({ interceptorsServer: createInterceptorServer(core) });
    const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("adtl.policy failed");
    expect(posted).toHaveLength(0);
  });

  describe("approvals", () => {
    async function untrustedSession(decision: "allow" | "deny" | "never", timeoutMs = 5000) {
      const push = new AutoAnswer(decision);
      const s = await setup({ approvals: new ApprovalBroker({ notifiers: [push], timeoutMs }) });
      await s.call("github__read_issue", { repo: "acme/website", number: 42 });
      return { ...s, push };
    }

    it("runs an asked call once a human approves it", async () => {
      const { call, posted, audit, push } = await untrustedSession("allow");
      const r = await call("github__post_comment", { repo: "acme/website", number: 42, body: "hello" });
      expect(r.isError).toBeFalsy();
      expect(posted).toHaveLength(1);
      const pending = push.events.find((e) => e.kind === "pending");
      expect(pending).toMatchObject({ request: { server: "github", tool: "post_comment", matched: ["no-public-write-after-untrusted"] } });
      expect(JSON.stringify(pending)).not.toContain("hello"); // no arguments in notifications
      expect(audit.entries[1]).toMatchObject({ outcome: "forwarded", decision: "ask", approval: { outcome: "approved", channel: "auto" } });
    });

    it("stops the call when the human denies it", async () => {
      const { call, posted, audit } = await untrustedSession("deny");
      const r = await call("github__post_comment", { repo: "acme/website", number: 42, body: "hello" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("denied");
      expect(r._meta?.[GATEWAY_DECISION_KEY]).toMatchObject({ decision: "ask", approval: { outcome: "denied" } });
      expect(posted).toHaveLength(0);
      expect(audit.entries[1]).toMatchObject({ outcome: "blocked", decision: "ask", approval: { outcome: "denied" } });
    });

    it("stops the call when nobody answers in time", async () => {
      const { call, posted } = await untrustedSession("never", 50);
      const r = await call("github__post_comment", { repo: "acme/website", number: 42, body: "hello" });
      expect(textOf(r)).toContain("Nobody answered in time");
      expect(posted).toHaveLength(0);
    });

    it("never asks about a block, and sends a blocked notice", async () => {
      const { call, posted, push } = await untrustedSession("allow");
      await call("github__get_file", { repo: "acme/internal", path: "secrets.env" });
      const r = await call("github__post_comment", { repo: "acme/website", number: 42, body: "leak" });
      expect(textOf(r)).toContain("ADTL blocked this call");
      expect(posted).toHaveLength(0);
      await new Promise((res) => setTimeout(res, 5));
      expect(push.events.map((e) => e.kind)).toEqual(["blocked"]);
    });

    it("reports progress while waiting", async () => {
      const push = new AutoAnswer("allow");
      const { agent } = await setup({ approvals: new ApprovalBroker({ notifiers: [push], timeoutMs: 5000 }) });
      await agent.callTool({ name: "github__read_issue", arguments: { repo: "acme/website", number: 42 } });
      const progress: string[] = [];
      const r = (await agent.callTool({ name: "github__post_comment", arguments: { repo: "acme/website", number: 42, body: "x" } }, undefined, {
        onprogress: (p) => void progress.push(p.message ?? ""),
      })) as CallToolResult;
      expect(r.isError).toBeFalsy();
      expect(progress[0]).toContain("Waiting for a human");
    });
  });

  describe("audit mode", () => {
    it("lets the attack through but logs every call the policy would have stopped", async () => {
      const { call, posted, audit } = await setup({ mode: "audit" });
      await call("github__read_issue", { repo: "acme/website", number: 42 });
      const ask = await call("github__post_comment", { repo: "acme/website", number: 42, body: "hello" });
      expect(ask.isError).toBeFalsy();
      await call("github__get_file", { repo: "acme/internal", path: "secrets.env" });
      const leak = await call("github__post_comment", { repo: "acme/website", number: 42, body: "leak" });
      expect(leak.isError).toBeFalsy();
      expect(posted).toHaveLength(2);

      expect(audit.entries.map((e) => [e.tool, e.outcome, e.decision, e.mode])).toEqual([
        ["read_issue", "forwarded", "allow", "audit"],
        ["post_comment", "forwarded", "ask", "audit"],
        ["get_file", "forwarded", "allow", "audit"],
        ["post_comment", "forwarded", "block", "audit"],
      ]);
      // Labels keep accumulating, so the decisions match what active mode would do.
      expect(audit.entries[3]).toMatchObject({
        matched: ["private-stays-private"],
        reason: "Private data must not reach a public tool",
        sessionLabel: { integrity: "untrusted", confidentiality: "private" },
      });
      expect(audit.entries[0]).not.toHaveProperty("reason");
    });

    it("does not change results", async () => {
      const { call } = await setup({ mode: "audit" });
      const issue = await call("github__read_issue", { repo: "acme/website", number: 42 });
      expect(issue._meta?.[TRUST_KEY]).toBeUndefined();
    });

    it("forwards the call when an interceptor fails, with a warning", async () => {
      const config = parseConfigText(readFileSync(CONFIG, "utf8"));
      const core = new AdtlInterceptors({ config });
      const original = core.invoke.bind(core);
      core.invoke = (p) => {
        if (p.name === "adtl.policy") throw new Error("boom");
        return original(p);
      };
      const { call, posted, audit } = await setup({ interceptorsServer: createInterceptorServer(core), mode: "audit" });
      const r = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
      expect(r.isError).toBeFalsy();
      expect(posted).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({ outcome: "forwarded", mode: "audit" });
      expect(audit.entries[0]).not.toHaveProperty("decision");
      expect(audit.entries[0]!.warnings?.[0]).toContain("adtl.policy failed");
    });
  });
});
