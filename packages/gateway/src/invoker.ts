/**
 * Runs interceptors in the order SEP-2624 requires:
 *
 * - Sending (request phase, gateway → upstream): Mutate (sequential, by
 *   priorityHint then name) → Validate (parallel).
 * - Receiving (response phase, upstream → gateway): Validate (parallel) →
 *   Mutate (sequential).
 *
 * Only `severity: "error"` blocks. Audit-mode interceptors never block, and
 * their mutations are not applied. An interceptor that fails (error or
 * timeout) blocks the message unless it declares `failOpen: true`.
 *
 * The invoker may override every interceptor's `mode`, as SEP-2624 allows
 * (e.g. audit in staging, active in production).
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  DECISION_INFO_KEY,
  INVOKE_METHOD,
  LIST_METHOD,
  type InterceptorDefinition,
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

/** Untyped request: interceptor methods are extension methods the SDK does not type. */
function request(client: Client, method: string, params: unknown, timeout: number): Promise<Loose> {
  const r = client.request as unknown as (req: unknown, schema: unknown, opts: unknown) => Promise<Loose>;
  return r.call(client, { method, params }, AnyResult, { timeout });
}

export type InterceptorMode = NonNullable<InterceptorDefinition["mode"]>;

export interface BoundInterceptor {
  client: Client;
  definition: InterceptorDefinition;
}

export interface Blocked {
  interceptor: string;
  decision: Decision;
  reason: string;
}

export interface PhaseOutcome {
  payload: unknown;
  blocked?: Blocked;
  results: InterceptorResult[];
  /** Interceptors that failed but were allowed to (failOpen or audit mode). */
  warnings: string[];
}

export interface InvokeOptions {
  event: string;
  payload: unknown;
  config: Record<string, unknown>;
  context: InvocationContext;
}

function priority(def: InterceptorDefinition, phase: Phase): number {
  const p = def.priorityHint;
  if (p === undefined) return 0;
  if (typeof p === "number") return p;
  return p[phase] ?? 0;
}

function hooks(def: InterceptorDefinition, event: string, phase: Phase): boolean {
  return def.hooks.some((h) => h.phase === phase && (h.events.includes(event) || h.events.includes("*")));
}

export class InterceptorInvoker {
  constructor(
    private readonly interceptors: BoundInterceptor[],
    private readonly timeoutMs = 5000,
    /** Overrides the mode every interceptor declares. */
    readonly modeOverride?: InterceptorMode,
  ) {}

  /** Discover the interceptors an interceptor server offers. */
  static async discover(client: Client): Promise<BoundInterceptor[]> {
    const res = await request(client, LIST_METHOD, {}, 10_000);
    const defs = (res.interceptors ?? []) as InterceptorDefinition[];
    return defs.map((definition) => ({ client, definition }));
  }

  get definitions(): InterceptorDefinition[] {
    return this.interceptors.map((i) => i.definition);
  }

  async runRequest(opts: InvokeOptions): Promise<PhaseOutcome> {
    const out: PhaseOutcome = { payload: opts.payload, results: [], warnings: [] };
    if (!(await this.mutate("request", opts, out))) return out;
    await this.validate("request", opts, out);
    return out;
  }

  async runResponse(opts: InvokeOptions): Promise<PhaseOutcome> {
    const out: PhaseOutcome = { payload: opts.payload, results: [], warnings: [] };
    if (!(await this.validate("response", opts, out))) return out;
    await this.mutate("response", opts, out);
    return out;
  }

  private isAudit(i: BoundInterceptor): boolean {
    return (this.modeOverride ?? i.definition.mode) === "audit";
  }

  private select(type: InterceptorDefinition["type"], event: string, phase: Phase): BoundInterceptor[] {
    return this.interceptors.filter((i) => i.definition.type === type && hooks(i.definition, event, phase));
  }

  private async invoke(i: BoundInterceptor, phase: Phase, opts: InvokeOptions, payload: unknown): Promise<InterceptorResult> {
    const res = await request(
      i.client,
      INVOKE_METHOD,
      { name: i.definition.name, event: opts.event, phase, payload, config: opts.config, timeoutMs: this.timeoutMs, context: opts.context },
      this.timeoutMs,
    );
    return res as unknown as InterceptorResult;
  }

  /** Handle an interceptor failure. Returns false if the phase must stop. */
  private failed(i: BoundInterceptor, err: unknown, out: PhaseOutcome): boolean {
    const msg = `${i.definition.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    if (this.isAudit(i) || i.definition.failOpen === true) {
      out.warnings.push(msg);
      return true;
    }
    out.blocked = { interceptor: i.definition.name, decision: "block", reason: msg };
    return false;
  }

  /** Sequential mutations, atomic: on failure the original payload is kept. */
  private async mutate(phase: Phase, opts: InvokeOptions, out: PhaseOutcome): Promise<boolean> {
    const selected = this.select("mutation", opts.event, phase).sort(
      (a, b) => priority(a.definition, phase) - priority(b.definition, phase) || a.definition.name.localeCompare(b.definition.name),
    );
    let payload = out.payload;
    for (const i of selected) {
      let r: MutationResult;
      try {
        r = (await this.invoke(i, phase, opts, payload)) as MutationResult;
      } catch (err) {
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
    const settled = await Promise.allSettled(selected.map((i) => this.invoke(i, phase, opts, out.payload)));
    let ok = true;
    settled.forEach((s, idx) => {
      const i = selected[idx]!;
      if (s.status === "rejected") {
        if (!this.failed(i, s.reason, out)) ok = false;
        return;
      }
      const r = s.value as ValidationResult;
      out.results.push(r);
      if (r.valid || r.severity !== "error" || this.isAudit(i)) return;
      // Keep the strictest rejection, so an "ask" never hides another validator's "block".
      if (!out.blocked || out.blocked.decision === "ask") {
        const decision = (r.info?.[DECISION_INFO_KEY] as Decision | undefined) ?? "block";
        const reason = r.messages?.map((m) => m.message).join("; ") || `${i.definition.name} rejected the call`;
        if (!out.blocked || decision === "block") out.blocked = { interceptor: i.definition.name, decision, reason };
      }
      ok = false;
    });
    return ok;
  }
}
