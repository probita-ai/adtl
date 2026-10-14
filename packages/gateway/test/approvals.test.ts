import { afterEach, describe, expect, it } from "vitest";
import { ApprovalBroker, ApprovalTokens, EmailNotifier, NtfyNotifier, type AnswerFn, type ApprovalEvent, type Notifier } from "../src/index.js";
import { startFakeNtfy } from "./fakeNtfy.js";

const CALL = { sessionId: "s1", server: "github", tool: "post_comment", callHash: "sha256:abc", reason: "Untrusted session", matched: ["r1"] };

/** A notifier that can carry answers and lets the test answer by hand. */
class FakePush implements Notifier {
  readonly name = "fake";
  events: ApprovalEvent[] = [];
  answer: AnswerFn | undefined;
  fail = false;
  async notify(e: ApprovalEvent) {
    if (this.fail && e.kind === "pending") throw new Error("down");
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

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ApprovalTokens", () => {
  const tokens = new ApprovalTokens();
  const req = { id: "id1", callHash: "sha256:abc", expiresAt: new Date(Date.now() + 60_000) };

  it("verifies a token only for the call it was made for", () => {
    const allow = tokens.sign(req, "allow");
    expect(tokens.verify(allow, req, new Date())).toBe("allow");
    expect(tokens.verify(tokens.sign(req, "deny"), req, new Date())).toBe("deny");
    expect(tokens.verify(allow, { ...req, callHash: "sha256:other" }, new Date())).toBeUndefined();
    expect(tokens.verify(allow, { ...req, id: "id2" }, new Date())).toBeUndefined();
  });

  it("rejects expired, tampered and foreign tokens", () => {
    const allow = tokens.sign(req, "allow");
    expect(tokens.verify(allow, req, new Date(Date.now() + 120_000))).toBeUndefined();
    expect(tokens.verify(allow.replace(".allow.", ".deny."), req, new Date())).toBeUndefined();
    expect(tokens.verify(tokens.sign(req, "deny").replace(".deny.", ".allow."), req, new Date())).toBeUndefined();
    expect(tokens.verify(new ApprovalTokens().sign(req, "allow"), req, new Date())).toBeUndefined();
    expect(tokens.verify("hello", req, new Date())).toBeUndefined();
  });
});

describe("ApprovalBroker", () => {
  it("resolves approved / denied from a signed answer, once", async () => {
    const push = new FakePush();
    const broker = new ApprovalBroker({ notifiers: [push], timeoutMs: 5000 });
    expect(broker.canApprove).toBe(true);

    const pending = broker.request(CALL);
    await tick();
    expect(push.answer!(push.tokens!.allow)).toBe(true);
    expect(await pending).toMatchObject({ outcome: "approved", channel: "fake" });
    // Single use: the same token no longer settles anything.
    expect(broker.answer(push.tokens!.allow, "fake")).toBe(false);
    await tick();
    expect(push.events.map((e) => e.kind)).toEqual(["pending", "resolved"]);

    const push2 = new FakePush();
    const b2 = new ApprovalBroker({ notifiers: [push2], timeoutMs: 5000 });
    const p2 = b2.request(CALL);
    await tick();
    push2.answer!(push2.tokens!.deny);
    expect((await p2).outcome).toBe("denied");
  });

  it("ignores answers meant for another call", async () => {
    const push = new FakePush();
    const broker = new ApprovalBroker({ notifiers: [push], timeoutMs: 100 });
    const first = broker.request(CALL);
    await tick();
    const tokenForFirst = push.tokens!.allow;
    push.answer!(push.tokens!.deny);
    await first;

    push.events = [];
    const second = broker.request({ ...CALL, callHash: "sha256:different" });
    await tick();
    expect(push.answer!(tokenForFirst)).toBe(false);
    expect((await second).outcome).toBe("timeout");
  });

  it("times out, and fails fast when no answering channel was reached", async () => {
    const push = new FakePush();
    expect((await new ApprovalBroker({ notifiers: [push], timeoutMs: 30 }).request(CALL)).outcome).toBe("timeout");

    const down = new FakePush();
    down.fail = true;
    const started = Date.now();
    const r = await new ApprovalBroker({ notifiers: [down], timeoutMs: 5000 }).request(CALL);
    expect(r.outcome).toBe("undeliverable");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not wait for slow notify-only channels", async () => {
    const push = new FakePush();
    const slowMail: Notifier = { name: "mail", notify: () => new Promise((r) => setTimeout(r, 2000)) };
    const broker = new ApprovalBroker({ notifiers: [slowMail, push], timeoutMs: 5000 });
    expect(new ApprovalBroker({ notifiers: [slowMail], timeoutMs: 10 }).canApprove).toBe(false);
    const started = Date.now();
    const p = broker.request(CALL);
    await tick();
    push.answer!(push.tokens!.allow);
    expect((await p).outcome).toBe("approved");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("NtfyNotifier", () => {
  let ntfy: Awaited<ReturnType<typeof startFakeNtfy>> | undefined;
  afterEach(async () => {
    await ntfy?.close();
    ntfy = undefined;
  });

  it("sends Allow / Deny buttons and reads the answer from the reply topic", async () => {
    ntfy = await startFakeNtfy();
    const broker = new ApprovalBroker({ notifiers: [new NtfyNotifier({ server: ntfy.url, topic: "adtl-test" })], timeoutMs: 5000 });
    const p = broker.request(CALL);
    const sent = await ntfy.press("adtl-test", "Allow");
    expect((await p).outcome).toBe("approved");
    expect(sent.title).toBe("ADTL: allow github.post_comment?");
    expect(sent.message).toContain("Untrusted session");
    expect(sent.actions!.map((a) => a.label)).toEqual(["Allow", "Deny"]);
    expect(sent.actions![0]!.url).toBe(`${ntfy.url}/adtl-test-reply`);
  });

  it("ignores forged answers", async () => {
    ntfy = await startFakeNtfy();
    const broker = new ApprovalBroker({ notifiers: [new NtfyNotifier({ server: ntfy.url, topic: "t" })], timeoutMs: 300 });
    const p = broker.request(CALL);
    await ntfy.press("t", "Deny", { tamper: (b) => b.replace(".deny.", ".allow.") });
    expect((await p).outcome).toBe("timeout");
  });

  it("uses the access token for publishing, subscribing and the buttons", async () => {
    ntfy = await startFakeNtfy({ requireToken: "tk_secret" });
    const broker = new ApprovalBroker({ notifiers: [new NtfyNotifier({ server: ntfy.url, topic: "t", token: "tk_secret" })], timeoutMs: 5000 });
    const p = broker.request(CALL);
    await ntfy.press("t", "Allow");
    expect((await p).outcome).toBe("approved");
  });

  it("retries a publish that hits a network error", async () => {
    ntfy = await startFakeNtfy();
    let calls = 0;
    const flaky: typeof fetch = (input, init) => {
      if (init?.method === "POST" && calls++ === 0) return Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
      return fetch(input, init);
    };
    const broker = new ApprovalBroker({
      notifiers: [new NtfyNotifier({ server: ntfy.url, topic: "t", fetch: flaky, reconnectMs: 10 })],
      timeoutMs: 5000,
    });
    const p = broker.request(CALL);
    await ntfy.press("t", "Allow");
    expect((await p).outcome).toBe("approved");
    expect(calls).toBeGreaterThan(1);
  });

  it("gives up after the last attempt and says why", async () => {
    const warnings: string[] = [];
    const down: typeof fetch = () => Promise.reject(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
    const broker = new ApprovalBroker({
      notifiers: [new NtfyNotifier({ server: "http://x", topic: "t", fetch: down, reconnectMs: 1 })],
      timeoutMs: 5000,
      log: { warn: (m) => warnings.push(m) },
    });
    expect((await broker.request(CALL)).outcome).toBe("undeliverable");
    expect(warnings[0]).toContain("fetch failed (ECONNRESET)");
  });

  it("reports the server being unreachable as undeliverable", async () => {
    const broker = new ApprovalBroker({ notifiers: [new NtfyNotifier({ server: "http://127.0.0.1:9", topic: "t" })], timeoutMs: 5000 });
    expect((await broker.request(CALL)).outcome).toBe("undeliverable");
  });
});

describe("EmailNotifier", () => {
  it("sends only the configured events, never approve links or arguments", async () => {
    const sent: { subject: string; text: string; to: string[] }[] = [];
    const email = new EmailNotifier({ from: "adtl@x", to: ["me@x"], on: ["pending", "blocked"], sender: { sendMail: async (m) => sent.push(m) } });
    const push = new FakePush();
    const broker = new ApprovalBroker({ notifiers: [email, push], timeoutMs: 5000 });
    const p = broker.request(CALL);
    await tick();
    push.answer!(push.tokens!.allow);
    await p;
    broker.blocked({ sessionId: "s1", server: "github", tool: "post_comment", reason: "Private data", matched: ["r2"] });
    await tick();

    expect(sent.map((m) => m.subject)).toEqual(["ADTL: approval needed for github.post_comment", "ADTL blocked github.post_comment"]);
    expect(sent[0]!.to).toEqual(["me@x"]);
    expect(sent.map((m) => m.text).join("\n")).not.toMatch(/adtl1\.|https?:\/\//);
  });
});
