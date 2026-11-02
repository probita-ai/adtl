/**
 * Runs interceptors in the order SEP-2624 requires:
 *
 * - Sending (request phase, gateway → upstream): Mutate (sequential, by
 *   priorityHint then name) → Validate (parallel).
 * - Receiving (response phase, upstream → gateway): Validate (parallel) →
 *   Mutate (sequential).
 *
 * Only `severity: "error"` blocks. A blocking result with a `confirmation`
 * request is an "ask"; the gateway may ask a human and re-validate. Audit-mode interceptors never block, and
 * their mutations are not applied. An interceptor that fails (error or
 * timeout) blocks the message unless it declares `failOpen: true`.
 *
 * The invoker may override execution policy, as SEP-2624 allows: every
 * interceptor's `mode` at once (e.g. audit in staging, active in production),
 * and per interceptor its `failOpen`, `priorityHint`, `mode`, `timeoutMs` and
 * `hooks` (narrowed only, never widened). A global mode wins over a
 * per-interceptor one, so `--audit` always stops nothing.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  DECISION_INFO_KEY,
  INVOKE_METHOD,
  LIST_METHOD,
  type ConfirmationRequest,
  type InterceptorDefinition,
  type InterceptorHook,
  type InterceptorResult,
  type InvocationContext,
  type MutationResult,
  type Phase,
  type ValidationResult,
} from "@adtl/interceptors";
import type { Decision } from "@adtl/labels";
import { z } from "zod";

const AnyResult = z.object({}).passthrough();

type Loose = Record<string, unknown>;

/**
 * Untyped request: interceptor methods are extension methods the SDK does not type.
 * The timeout is enforced here too, so a client that ignores it can't hang a phase.
 */
function request(client: Client, method: string, params: unknown, timeout: number): Promise<Loose> {
  const r = client.request as unknown as (req: unknown, schema: unknown, opts: unknown) => Promise<Loose>;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`timed out after ${timeout} ms`));
    }, timeout);
  });
  return Promise.race([r.call(client, { method, params }, AnyResult, { timeout, signal: controller.signal }), expired]).finally(() =>
    clearTimeout(timer),
  );
}

export type InterceptorMode = NonNullable<InterceptorDefinition["mode"]>;

/** Invoker-side execution policy for one interceptor (SEP-2624 "Invoker Overrides"). */
export interface InterceptorOverrides {
  failOpen?: boolean;
  /** Ignored for validators. */
  priorityHint?: InterceptorDefinition["priorityHint"];
  mode?: InterceptorMode;
  timeoutMs?: number;
  /** Must be a subset of the interceptor's declared hooks. */
  hooks?: InterceptorHook[];
}

export interface BoundInterceptor {
  client: Client;
  definition: InterceptorDefinition;
  /** Id of the interceptor server that advertised it, for messages. */
  server?: string;
  /**
   * Whether the gateway's per-call `config` (ADTL's server, tool and
   * annotations) is sent. Other servers' interceptors get none, so their
   * own defaults apply. Default: true.
   */
  sendConfig?: boolean;
}

export interface Blocked {
  interceptor: string;
  decision: Decision;
  reason: string;
  /** Set when the validator would accept a human confirmation. */
  confirmation?: ConfirmationRequest;
}

/**
 * One interceptor invocation, with the execution policy it ran under. SEP-2624
 * (Security Best Practice 3) asks invokers to log the resolved `mode` and
 * `failOpen`, and whether each came from an invoker override or the
 * interceptor's declared default.
 */
export interface InterceptorRun {
  name: string;
  phase: Phase;
  mode: InterceptorMode;
  modeFrom: "override" | "default";
  failOpen: boolean;
  failOpenFrom: "override" | "default";
  timeoutMs: number;
  /** Set when the invocation errored or timed out. */
  failed?: true;
}

export interface PhaseOutcome {
  payload: unknown;
  blocked?: Blocked;
  results: InterceptorResult[];
  /** Interceptors that failed but were allowed to (failOpen or audit mode). */
  warnings: string[];
  /** Every interceptor invoked in this phase. */
  ran: InterceptorRun[];
}

export interface InvokeOptions {
  event: string;
  payload: unknown;
  config: Record<string, unknown>;
  context: InvocationContext;
}

/** SEP-2624 `resolvePriority`: the override's hint, else the interceptor's. */
export function resolvePriority(def: InterceptorDefinition, overrides: InterceptorOverrides | undefined, phase: Phase): number {
  const p = overrides?.priorityHint ?? def.priorityHint;
  if (p === undefined) return 0;
  if (typeof p === "number") return p;
  return p[phase] ?? 0;
}

function matches(hooks: InterceptorHook[], event: string, phase: Phase): boolean {
  return hooks.some((h) => h.phase === phase && (h.events.includes(event) || h.events.includes("*")));
}

/**
 * Problems with `overrides` for these interceptors: an unknown name, or hooks
 * that widen what the interceptor declares (which SEP-2624 says to reject).
 */
export function checkOverrides(defs: InterceptorDefinition[], overrides: Record<string, InterceptorOverrides>): string[] {
  const problems: string[] = [];
  for (const [name, o] of Object.entries(overrides)) {
    const def = defs.find((d) => d.name === name);
    if (!def) {
      problems.push(`${name}: no such interceptor (offered: ${defs.map((d) => d.name).join(", ")})`);
      continue;
    }
    for (const h of o.hooks ?? []) {
      for (const event of h.events) {
        const declared = def.hooks.some((d) => d.phase === h.phase && (d.events.includes("*") || (event !== "*" && d.events.includes(event))));
        if (!declared) problems.push(`${name}: hooks may only narrow the declared hooks, and ${event} (${h.phase}) is not declared`);
      }
    }
  }
  return problems;
}

/** Interceptor names offered by more than one server: each must be invoked on its own server, so names must be unique. */
export function duplicateInterceptors(bound: BoundInterceptor[]): string[] {
  const servers = new Map<string, string[]>();
  for (const b of bound) servers.set(b.definition.name, [...(servers.get(b.definition.name) ?? []), b.server ?? "?"]);
  return [...servers].filter(([, s]) => s.length > 1).map(([name, s]) => `${name} (offered by ${s.join(", ")})`);
}

/**
 * Mutators that would run after `name` on a phase both hook, so they see (and
 * could change or drop) what it wrote. Used to warn when another server's
 * mutator runs after adtl.label.
 */
export function mutatorsAfter(bound: BoundInterceptor[], name: string, overrides: Record<string, InterceptorOverrides> = {}): string[] {
  const target = bound.find((b) => b.definition.name === name);
  if (!target) return [];
  const hooksOf = (b: BoundInterceptor) => overrides[b.definition.name]?.hooks ?? b.definition.hooks;
  const shares = (b: BoundInterceptor, phase: Phase) =>
    hooksOf(b).some((h) => h.phase === phase && hooksOf(target).some((t) => t.phase === phase && (h.events.includes("*") || t.events.includes("*") || h.events.some((e) => t.events.includes(e)))));
  const after: string[] = [];
  for (const b of bound) {
    if (b === target || b.definition.type !== "mutation") continue;
    const late = (["request", "response"] as const).some((phase) => {
      if (!shares(b, phase)) return false;
      const p = resolvePriority(b.definition, overrides[b.definition.name], phase);
      const t = resolvePriority(target.definition, overrides[name], phase);
      return p > t || (p === t && b.definition.name.localeCompare(name) > 0);
    });
    if (late) after.push(b.definition.name);
  }
  return after;
}

export class InterceptorInvoker {
  constructor(
    private readonly interceptors: BoundInterceptor[],
    private readonly timeoutMs = 5000,
    /** Overrides the mode every interceptor declares. */
    readonly modeOverride?: InterceptorMode,
    /** Per-interceptor overrides, by name. Check them with `checkOverrides` first. */
    private readonly overrides: Record<string, InterceptorOverrides> = {},
  ) {}

  /** Discover the interceptors an interceptor server offers. */
  static async discover(client: Client, opts: { server?: string; sendConfig?: boolean } = {}): Promise<BoundInterceptor[]> {
    const res = await request(client, LIST_METHOD, {}, 10_000);
    const defs = (res.interceptors ?? []) as InterceptorDefinition[];
    return defs.map((definition) => ({ client, definition, ...opts }));
  }

  get definitions(): InterceptorDefinition[] {
    return this.interceptors.map((i) => i.definition);
  }

  async runRequest(opts: InvokeOptions): Promise<PhaseOutcome> {
    const out: PhaseOutcome = { payload: opts.payload, results: [], warnings: [], ran: [] };
    if (!(await this.mutate("request", opts, out))) return out;
    await this.validate("request", opts, out);
    return out;
  }

  async runResponse(opts: InvokeOptions): Promise<PhaseOutcome> {
    const out: PhaseOutcome = { payload: opts.payload, results: [], warnings: [], ran: [] };
    if (!(await this.validate("response", opts, out))) return out;
    await this.mutate("response", opts, out);
    return out;
  }

  private override(i: BoundInterceptor): InterceptorOverrides | undefined {
    return this.overrides[i.definition.name];
  }

  private mode(i: BoundInterceptor): InterceptorMode {
    return this.modeOverride ?? this.override(i)?.mode ?? i.definition.mode ?? "active";
  }

  private isAudit(i: BoundInterceptor): boolean {
    return this.mode(i) === "audit";
  }

  private failOpen(i: BoundInterceptor): boolean {
    return (this.override(i)?.failOpen ?? i.definition.failOpen) === true;
  }

  private timeout(i: BoundInterceptor): number {
    return this.override(i)?.timeoutMs ?? this.timeoutMs;
  }

  /** Record that `i` runs in `phase`, with its resolved policy. */
  private run(i: BoundInterceptor, phase: Phase, out: PhaseOutcome): InterceptorRun {
    const o = this.override(i);
    const r: InterceptorRun = {
      name: i.definition.name,
      phase,
      mode: this.mode(i),
      modeFrom: this.modeOverride || o?.mode ? "override" : "default",
      failOpen: this.failOpen(i),
      failOpenFrom: o?.failOpen !== undefined ? "override" : "default",
      timeoutMs: this.timeout(i),
    };
    out.ran.push(r);
    return r;
  }

  private select(type: InterceptorDefinition["type"], event: string, phase: Phase): BoundInterceptor[] {
    return this.interceptors.filter(
      (i) => i.definition.type === type && matches(this.override(i)?.hooks ?? i.definition.hooks, event, phase),
    );
  }

  private async invoke(i: BoundInterceptor, phase: Phase, opts: InvokeOptions, payload: unknown): Promise<InterceptorResult> {
    const timeoutMs = this.timeout(i);
    const res = await request(
      i.client,
      INVOKE_METHOD,
      {
        name: i.definition.name,
        event: opts.event,
        phase,
        payload,
        ...(i.sendConfig === false ? {} : { config: opts.config }),
        timeoutMs,
        context: opts.context,
      },
      timeoutMs,
    );
    return res as unknown as InterceptorResult;
  }

  /** Handle an interceptor failure. Returns false if the phase must stop. */
  private failed(i: BoundInterceptor, err: unknown, out: PhaseOutcome): boolean {
    const msg = `${i.definition.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    if (this.isAudit(i) || this.failOpen(i)) {
      out.warnings.push(msg);
      return true;
    }
    out.blocked = { interceptor: i.definition.name, decision: "block", reason: msg };
    return false;
  }

  /** Sequential mutations, atomic: on failure the original payload is kept. */
  private async mutate(phase: Phase, opts: InvokeOptions, out: PhaseOutcome): Promise<boolean> {
    const selected = this.select("mutation", opts.event, phase).sort(
      (a, b) =>
        resolvePriority(a.definition, this.override(a), phase) - resolvePriority(b.definition, this.override(b), phase) ||
        a.definition.name.localeCompare(b.definition.name),
    );
    let payload = out.payload;
    for (const i of selected) {
      const ran = this.run(i, phase, out);
      let r: MutationResult;
      try {
        r = (await this.invoke(i, phase, opts, payload)) as MutationResult;
      } catch (err) {
        ran.failed = true;
        if (!this.failed(i, err, out)) return false;
        continue;
      }
      out.results.push(r);
      if (!this.isAudit(i) && r.modified) payload = r.payload;
    }
    out.payload = payload;
    return true;
  }

  /** Parallel validations. Only severity "error" blocks. */
  private async validate(phase: Phase, opts: InvokeOptions, out: PhaseOutcome): Promise<boolean> {
    const selected = this.select("validation", opts.event, phase);
    const runs = selected.map((i) => this.run(i, phase, out));
    const settled = await Promise.allSettled(selected.map((i) => this.invoke(i, phase, opts, out.payload)));
    let ok = true;
    settled.forEach((s, idx) => {
      const i = selected[idx]!;
      if (s.status === "rejected") {
        runs[idx]!.failed = true;
        if (!this.failed(i, s.reason, out)) ok = false;
        return;
      }
      const r = s.value as ValidationResult;
      out.results.push(r);
      if (r.valid || r.severity !== "error" || this.isAudit(i)) return;
      // Keep the strictest rejection, so an "ask" never hides another validator's "block".
      if (!out.blocked || out.blocked.decision === "ask") {
        // Older ADTL interceptor servers carry "ask" only in info.
        const decision = r.confirmation ? "ask" : ((r.info?.[DECISION_INFO_KEY] as Decision | undefined) ?? "block");
        const reason = r.messages?.map((m) => m.message).join("; ") || `${i.definition.name} rejected the call`;
        if (!out.blocked || decision === "block") {
          out.blocked = { interceptor: i.definition.name, decision, reason, ...(r.confirmation ? { confirmation: r.confirmation } : {}) };
        }
      }
      ok = false;
    });
    return ok;
  }
}
