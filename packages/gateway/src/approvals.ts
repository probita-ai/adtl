/**
 * Human approvals for "ask" decisions.
 *
 * When adtl.policy answers `ask`, the gateway holds the call and asks the
 * broker. The broker sends the request to every notifier and waits for an
 * answer from a notifier that can carry one (e.g. ntfy). No answer before the
 * timeout means deny.
 *
 * Answers are signed tokens: HMAC over the approval id, the call's hash, the
 * decision and an expiry. A token only ever answers the one pending call it
 * was made for, and only once. Anyone who can read the push channel can still
 * use the tokens sent on it, so that channel must stay private.
 *
 * A request can name its approvers (policy rule `approvers:`). It then goes
 * only to those people's own channels, each with tokens signed for that
 * person, and an answer counts only if it comes back on the same person's
 * channel. So the result names who approved, and nobody else can.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type ApprovalDecision = "allow" | "deny";
export type ApprovalOutcome = "approved" | "denied" | "timeout" | "undeliverable";

export interface ApprovalRequest {
  id: string;
  sessionId: string;
  server: string;
  tool: string;
  callHash: string;
  reason: string;
  matched: string[];
  /** The session label that triggered the rule (no arguments or results). */
  sessionLabel?: unknown;
  /** People who may answer, reached on their own channels. Absent: the shared channels. */
  approvers?: string[];
  createdAt: Date;
  expiresAt: Date;
}

export interface ApprovalResult {
  outcome: ApprovalOutcome;
  /** Notifier that delivered the answer. */
  channel?: string;
  approver?: string;
  waitedMs: number;
}

export type ApprovalEvent =
  | { kind: "pending"; request: ApprovalRequest; tokens: Record<ApprovalDecision, string> }
  | { kind: "resolved"; request: ApprovalRequest; result: ApprovalResult }
  | { kind: "blocked"; sessionId: string; server: string; tool: string; reason: string; matched: string[] };

/** Called by a notifier with every answer it receives. Returns true if the answer was accepted. */
export type AnswerFn = (token: string, approver?: string) => boolean;

export interface Notifier {
  readonly name: string;
  /** Deliver an event. Throwing marks the delivery as failed; it never stops the call by itself. */
  notify(event: ApprovalEvent): Promise<void>;
  /**
   * Notifiers that can carry answers: pass every answer for `request` to
   * `answer` until `signal` aborts. Called before the pending event is sent.
   */
  listen?(request: ApprovalRequest, answer: AnswerFn, signal: AbortSignal): Promise<void>;
}

const TOKEN_PREFIX = "adtl1";

/** Error message plus its cause, e.g. "fetch failed (ECONNRESET)". */
export function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause as { code?: string; message?: string } | undefined;
  const detail = cause?.code ?? cause?.message;
  return detail && !err.message.includes(detail) ? `${err.message} (${detail})` : err.message;
}

export class ApprovalTokens {
  constructor(private readonly secret: Buffer = randomBytes(32)) {}

  /** A token answering `request` with `decision`; with `approver`, valid only as that person's answer. */
  sign(request: Pick<ApprovalRequest, "id" | "callHash" | "expiresAt">, decision: ApprovalDecision, approver?: string): string {
    const exp = Math.floor(request.expiresAt.getTime() / 1000);
    return `${TOKEN_PREFIX}.${request.id}.${decision}.${exp}.${this.mac(request.id, request.callHash, decision, exp, approver)}`;
  }

  /** Parse a token without verifying it. */
  static parse(token: string): { id: string; decision: ApprovalDecision; exp: number; sig: string } | undefined {
    const parts = token.trim().split(".");
    if (parts.length !== 5 || parts[0] !== TOKEN_PREFIX) return undefined;
    const [, id, decision, exp, sig] = parts as [string, string, string, string, string];
    if (decision !== "allow" && decision !== "deny") return undefined;
    if (!/^\d+$/.test(exp)) return undefined;
    return { id, decision, exp: Number(exp), sig };
  }

  /** Verify a token against the pending request it claims to answer. */
  verify(token: string, request: Pick<ApprovalRequest, "id" | "callHash">, now: Date, approver?: string): ApprovalDecision | undefined {
    const t = ApprovalTokens.parse(token);
    if (!t || t.id !== request.id) return undefined;
    if (now.getTime() > t.exp * 1000) return undefined;
    const expected = Buffer.from(this.mac(t.id, request.callHash, t.decision, t.exp, approver));
    const given = Buffer.from(t.sig);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return t.decision;
  }

  private mac(id: string, callHash: string, decision: ApprovalDecision, exp: number, approver?: string): string {
    const signed = `${id}\n${callHash}\n${decision}\n${exp}${approver === undefined ? "" : `\napprover:${approver}`}`;
    return createHmac("sha256", this.secret).update(signed).digest("base64url");
  }
}

export interface ApprovalBrokerOptions {
  notifiers: Notifier[];
  /** Each approver's own channels, by principal id. */
  approverChannels?: Map<string, Notifier[]>;
  timeoutMs: number;
  tokens?: ApprovalTokens;
  now?: () => Date;
  log?: { warn(msg: string): void };
}

interface Pending {
  request: ApprovalRequest;
  settle(decision: ApprovalDecision, channel: string, approver?: string): void;
}

/** A channel a request goes to, and whose answers it accepts on it (undefined: a shared channel). */
interface Target {
  notifier: Notifier;
  approver?: string;
}

export class ApprovalBroker {
  private readonly notifiers: Notifier[];
  private readonly approverChannels: Map<string, Notifier[]>;
  private readonly timeoutMs: number;
  private readonly tokens: ApprovalTokens;
  private readonly now: () => Date;
  private readonly log: { warn(msg: string): void };
  private readonly pending = new Map<string, Pending>();

  constructor(opts: ApprovalBrokerOptions) {
    this.notifiers = opts.notifiers;
    this.approverChannels = opts.approverChannels ?? new Map();
    this.timeoutMs = opts.timeoutMs;
    this.tokens = opts.tokens ?? new ApprovalTokens();
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? { warn: () => {} };
  }

  /** True if at least one channel can carry answers. Without one, "ask" stays a block. */
  get canApprove(): boolean {
    return this.notifiers.some((n) => n.listen) || [...this.approverChannels.values()].some((ns) => ns.some((n) => n.listen));
  }

  /** Where a request goes: the named approvers' own channels plus notice-only ones, or else every shared channel. */
  private targets(request: ApprovalRequest): Target[] {
    if (!request.approvers) return this.notifiers.map((notifier) => ({ notifier }));
    const own = request.approvers.flatMap((approver) => (this.approverChannels.get(approver) ?? []).map((notifier) => ({ notifier, approver })));
    // Shared channels that can answer would let anyone who reads them approve; notice-only ones (email) are fine.
    return [...own, ...this.notifiers.filter((n) => !n.listen).map((notifier) => ({ notifier }))];
  }

  /** Ask for approval and wait for the answer, the timeout, or a failure to reach anyone. */
  async request(input: Omit<ApprovalRequest, "id" | "createdAt" | "expiresAt">): Promise<ApprovalResult> {
    const createdAt = this.now();
    const request: ApprovalRequest = {
      ...input,
      id: randomUUID(),
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs),
    };
    const started = performance.now();
    const waited = () => Math.round(performance.now() - started);
    const abort = new AbortController();

    let finish!: (r: ApprovalResult) => void;
    const result = new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => finish({ outcome: "timeout", waitedMs: waited() }), this.timeoutMs);
      finish = (r) => {
        if (!this.pending.delete(request.id)) return; // already settled
        clearTimeout(timer);
        abort.abort();
        resolve(r);
      };
    });
    this.pending.set(request.id, {
      request,
      settle: (decision, channel, approver) =>
        finish({ outcome: decision === "allow" ? "approved" : "denied", channel, ...(approver ? { approver } : {}), waitedMs: waited() }),
    });

    // Start listening before anyone can answer, then send the request to every target.
    const targets = this.targets(request);
    for (const { notifier: n, approver } of targets.filter((t) => t.notifier.listen)) {
      n.listen!(request, (token, reportedBy) => this.answer(token, n.name, approver, reportedBy), abort.signal).catch((err: unknown) =>
        this.log.warn(`${n.name}: stopped listening for approvals: ${errorText(err)}`),
      );
    }
    const sent = targets.map(({ notifier: n, approver }) => {
      const tokens = { allow: this.tokens.sign(request, "allow", approver), deny: this.tokens.sign(request, "deny", approver) };
      return n.notify({ kind: "pending", request, tokens }).then(
        () => true,
        (err: unknown) => {
          this.log.warn(`${n.name}: could not send approval request: ${errorText(err)}`);
          return false;
        },
      );
    });
    // Nobody who could answer was reached: deny now rather than wait out the timeout.
    // Notify-only channels (email) are not waited for.
    void Promise.all(sent.filter((_, i) => targets[i]!.notifier.listen)).then((ok) => {
      if (!ok.includes(true)) finish({ outcome: "undeliverable", waitedMs: waited() });
    });

    const r = await result;
    this.broadcast({ kind: "resolved", request, result: r }, [...new Set(targets.map((t) => t.notifier))]);
    return r;
  }

  /**
   * Handle an answer token from a channel; `approver` is whose own channel it
   * came on, `reportedBy` who a shared channel says answered (recorded, not
   * trusted for anything). Returns true if it settled a pending approval.
   */
  answer(token: string, channel: string, approver?: string, reportedBy?: string): boolean {
    const parsed = ApprovalTokens.parse(token);
    const p = parsed && this.pending.get(parsed.id);
    if (!p) return false; // not ours, already answered, or garbage
    // A request with approvers takes answers only on their own channels.
    if (p.request.approvers && (approver === undefined || !p.request.approvers.includes(approver))) return false;
    const decision = this.tokens.verify(token, p.request, this.now(), approver);
    if (!decision) {
      this.log.warn(`${channel}: ignored an approval answer with a bad or expired signature`);
      return false;
    }
    p.settle(decision, channel, approver ?? reportedBy);
    return true;
  }

  /** Tell notifiers a call was blocked. Fire and forget. */
  blocked(event: Omit<Extract<ApprovalEvent, { kind: "blocked" }>, "kind">): void {
    this.broadcast({ kind: "blocked", ...event });
  }

  private broadcast(event: ApprovalEvent, notifiers: Notifier[] = this.notifiers): void {
    for (const n of notifiers) {
      n.notify(event).catch((err: unknown) => this.log.warn(`${n.name}: could not send ${event.kind} notice: ${errorText(err)}`));
    }
  }
}
