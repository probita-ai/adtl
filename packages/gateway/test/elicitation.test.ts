import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type CallToolResult, type ElicitRequest, type ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { AdtlInterceptors, createInterceptorServer, parseConfigText } from "@adtl/interceptors";
import { AdtlGateway, ApprovalBroker, InterceptorInvoker, MemoryAuditLog, TotpVerifier, totpCode, totpStep } from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer } from "../../../examples/fake-github/server.mjs";

const CONFIG = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));

const toClose: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.allSettled(toClose.splice(0).map((c) => c.close()));
});

async function linked(server: { connect(t: unknown): Promise<void> }, client: Client): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  toClose.push(client);
  return client;
}

const plain = (name: string) => new Client({ name, version: "0.0.0" });

/**
 * An agent session behind the gateway, with the example policy. `answer` is
 * how the person in the client responds to an elicitation; omit it for a
 * client without the capability.
 */
async function setup(opts: { answer?: (req: ElicitRequest) => ElicitResult; elicit?: boolean; approverRule?: boolean; totp?: TotpVerifier } = {}) {
  const text = readFileSync(CONFIG, "utf8");
  const config = parseConfigText(opts.approverRule ? text.replace("then: ask\n", "then: ask\n      approvers: [leads]\n") : text);
  const posted: unknown[] = [];
  const audit = new MemoryAuditLog();
  const gateway = new AdtlGateway({
    upstreams: new Map([["github", await linked(createFakeGithubServer({ onPost: (p: unknown) => posted.push(p) }), plain("gw→github"))]]),
    invoker: new InterceptorInvoker(await InterceptorInvoker.discover(await linked(createInterceptorServer(new AdtlInterceptors({ config })), plain("gw→ic"))), 5000),
    sessionId: "s",
    audit,
    approvals: new ApprovalBroker({ notifiers: [], timeoutMs: 2000 }),
    elicitApprovals: opts.elicit ?? true,
    ...(opts.totp ? { totp: opts.totp } : {}),
    ...(opts.approverRule ? { approverRoles: new Map([["leads", ["alice"]]]) } : {}),
    logger: { info: () => {}, warn: () => {} },
  });
  const asked: ElicitRequest[] = [];
  const agent = new Client({ name: "agent", version: "0.0.0" }, opts.answer ? { capabilities: { elicitation: {} } } : {});
  if (opts.answer) {
    const answer = opts.answer;
    agent.setRequestHandler(ElicitRequestSchema, async (req) => {
      asked.push(req);
      return answer(req);
    });
  }
  await linked(gateway.createServer(), agent);
  const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  // Read an untrusted issue, so the next public write is an "ask".
  await call("github__read_issue", { repo: "acme/website", number: 42 });
  const post = () => call("github__post_comment", { repo: "acme/website", number: 42, body: "BODY-7f3a" });
  return { post, posted, audit, asked };
}

describe("approvals in the MCP client (elicitation)", () => {
  it("asks in the client and runs the call when the person allows it", async () => {
    const s = await setup({ answer: () => ({ action: "accept", content: { decision: "allow" } }) });
    const r = await s.post();
    expect(r.isError).toBeFalsy();
    expect(s.posted).toHaveLength(1);
    expect(s.asked[0]?.params.message).toContain("allow github.post_comment?");
    expect(s.asked[0]?.params.message).not.toContain("BODY-7f3a"); // no arguments
    expect(s.audit.entries.at(-1)).toMatchObject({ outcome: "forwarded", approval: { outcome: "approved", channel: "elicitation" } });
  });

  it("stops the call on Deny, decline or dismiss", async () => {
    for (const answer of [
      () => ({ action: "accept" as const, content: { decision: "deny" } }),
      () => ({ action: "decline" as const }),
      () => ({ action: "cancel" as const }),
    ]) {
      const s = await setup({ answer });
      const r = await s.post();
      expect(r.isError).toBe(true);
      expect(s.posted).toHaveLength(0);
      expect(s.audit.entries.at(-1)).toMatchObject({ outcome: "blocked", approval: { outcome: "denied", channel: "elicitation" } });
    }
  });

  it("doesn't ask a client without the capability, or when elicitation is off", async () => {
    const none = await setup();
    expect((await none.post()).content[0]).toMatchObject({ text: expect.stringContaining("No approval channel is configured") });
    const off = await setup({ elicit: false, answer: () => ({ action: "accept", content: { decision: "allow" } }) });
    expect((await off.post()).isError).toBe(true);
    expect(off.asked).toEqual([]);
  });

  it("never asks the client for a rule with named approvers", async () => {
    const s = await setup({ approverRule: true, answer: () => ({ action: "accept", content: { decision: "allow" } }) });
    const r = await s.post();
    expect(r.isError).toBe(true);
    expect(s.asked).toEqual([]);
    expect(s.posted).toHaveLength(0);
  });
});

describe("approvals with an authenticator code (gateway.approvals.totp)", () => {
  const secret = Buffer.from("12345678901234567890");
  const NOW = 1_800_000_000_000;
  const verifier = () => {
    let last = 0;
    return new TotpVerifier(secret, { lastStep: () => last, setLastStep: (s) => (last = s) }, () => NOW);
  };
  const good = totpCode(secret, totpStep(NOW));

  it("asks for a code instead of Allow or Deny, and runs the call on the right one", async () => {
    const s = await setup({ elicit: false, totp: verifier(), answer: () => ({ action: "accept", content: { code: good } }) });
    expect((await s.post()).isError).toBeFalsy();
    expect(s.posted).toHaveLength(1);
    expect(s.asked[0]?.params.message).toContain("Enter the code from your authenticator app");
    expect(JSON.stringify(s.asked[0]?.params)).not.toContain('"decision"');
    expect(s.audit.entries.at(-1)).toMatchObject({ approval: { outcome: "approved", channel: "elicitation" } });
  });

  it("can't be approved by a client that accepts prompts by itself", async () => {
    const s = await setup({ totp: verifier(), answer: () => ({ action: "accept", content: { decision: "allow" } }) });
    expect((await s.post()).isError).toBe(true);
    expect(s.posted).toHaveLength(0);
    expect(s.asked).toHaveLength(3);
  });

  it("lets the person retry a wrong code, says so, and stops on decline", async () => {
    const answers = ["000000", good];
    const s = await setup({ totp: verifier(), answer: () => ({ action: "accept", content: { code: answers.shift()! } }) });
    expect((await s.post()).isError).toBeFalsy();
    expect(s.asked[1]?.params.message).toContain("That code was not right");
    const declined = await setup({ totp: verifier(), answer: () => ({ action: "decline" }) });
    expect((await declined.post()).isError).toBe(true);
    expect(declined.asked).toHaveLength(1);
  });

  it("accepts a code once: the next call needs a new one", async () => {
    const s = await setup({ totp: verifier(), answer: () => ({ action: "accept", content: { code: good } }) });
    expect((await s.post()).isError).toBeFalsy();
    expect((await s.post()).isError).toBe(true);
    expect(s.posted).toHaveLength(1);
  });
});
