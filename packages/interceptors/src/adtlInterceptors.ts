/**
 * ADTL's two interceptors, independent of any transport:
 *
 * - `adtl.label` (mutation, response phase of tools/call, resources/read and prompts/get;
 *   request phase of tools/call for record stamps):
 *   labels the result, attaches the label under `_meta`, and records it in
 *   the session.
 * - `adtl.policy` (validation, request phase of tools/call): checks the call
 *   against the session's accumulated label and the policy, returning
 *   allow / ask / block.
 *
 * For tools whose rule sets `labelInto`, `adtl.label` also runs on the request
 * phase and stamps the session label into that argument, so the label travels
 * with the stored record. With `scopeInto`, a tainted session's writes get a
 * scope id of their own, so servers that resolve references from earlier
 * messages of the same scope don't mix its text into clean sessions' records. Results of tools with `readLabels` are joined with
 * the stamps they carry (stricter only). See @adtl/labels recordLabel.
 *
 * With a ledger, `adtl.label` also re-labels content that a tainted session
 * wrote earlier (looked up by content hash), and records the text of the
 * call's arguments when the session is tainted, so the label follows that
 * text into files, memory servers and other agents.
 *
 * An "ask" is a blocking result with a `confirmation` request (the SEP-2624
 * draft in experimental-ext-interceptors#45), so an invoker that does not
 * implement confirmations blocks the call. The request carries the call
 * binding hash and an HMAC token over its id, that hash, the session and the
 * expiry. When the invoker re-invokes adtl.policy with that confirmation in
 * `context.confirmations`, the call is allowed, once. ADTL also still sets
 * `info["adtl/decision"]` for invokers that read it.
 *
 * Both share one SessionStore keyed by `context.sessionId`. Sharing state
 * between interceptor calls is listed as "Future" in SEP-2624, so ADTL keeps it
 * inside this interceptor server for now.
 *
 * Per-invocation `config` (set by the invoker, e.g. adtl-gateway):
 *   server          upstream MCP server id, as named in the ADTL config
 *                   (default: `context.target`; one of the two is required)
 *   tool            tool name, if the payload does not carry it
 *   resource        resource URI, if the payload does not carry it
 *   prompt          prompt name, if the payload does not carry it
 *   toolAnnotations MCP tool annotations from tools/list, e.g. { openWorldHint: true }
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  InMemorySessionStore,
  attachLabel,
  join,
  callBindingHash,
  evaluatePolicy,
  labelResult,
  readRecordLabels,
  scopeRecord,
  stampRecordLabel,
  toolEgress,
  type AdtlConfig,
  type Decision,
  type Label,
  type SessionStore,
} from "@adtl/labels";
import { valueHashes, type Ledger } from "@adtl/ledger";
import { z } from "zod";
import type {
  ConfirmationRequest,
  InterceptorDefinition,
  InterceptorResult,
  InvocationParams,
  MutationResult,
  ValidationResult,
} from "./types.js";

export const LABEL_INTERCEPTOR = "adtl.label";
export const POLICY_INTERCEPTOR = "adtl.policy";

/** Key in `ValidationResult.info` carrying ADTL's decision, for invokers that predate `confirmation`. */
export const DECISION_INFO_KEY = "adtl/decision";

export const VERSION = "0.6.0";

/** JSON-RPC error codes used for invocation errors. */
export const ErrorCodes = {
  InvalidParams: -32602,
} as const;

export class InterceptorError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InterceptorError";
  }
}

const CONFIG_SCHEMA: InterceptorDefinition["configSchema"] = {
  type: "object",
  properties: {
    server: { type: "string", description: "Upstream MCP server id, as named in the ADTL config. Default: context.target" },
    tool: { type: "string", description: "Tool name, if the payload does not carry it" },
    resource: { type: "string", description: "Resource URI, if the payload does not carry it" },
    prompt: { type: "string", description: "Prompt name, if the payload does not carry it" },
    toolAnnotations: { type: "object", description: "MCP tool annotations from tools/list" },
  },
};

const DEFINITIONS: InterceptorDefinition[] = [
  {
    name: LABEL_INTERCEPTOR,
    version: VERSION,
    description: "Labels tool, resource and prompt results with ADTL trust labels (MCP trust-annotations) and records them per session",
    type: "mutation",
    hooks: [
      { events: ["tools/call", "resources/read", "prompts/get"], phase: "response" },
      { events: ["tools/call"], phase: "request" },
    ],
    failOpen: false,
    // Run after other mutators: the label describes the final content, and no later mutator can drop the stamp.
    priorityHint: { request: 1000, response: 1000 },
    configSchema: CONFIG_SCHEMA,
  },
  {
    name: POLICY_INTERCEPTOR,
    version: VERSION,
    description: "Checks tool calls against the session's trust labels and the ADTL policy: allow, ask or block",
    type: "validation",
    hooks: [{ events: ["tools/call"], phase: "request" }],
    failOpen: false,
    configSchema: CONFIG_SCHEMA,
  },
];

const InvocationConfigSchema = z
  .object({
    server: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    resource: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    toolAnnotations: z.object({ openWorldHint: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();
/** Config with the server resolved (from `config.server`, else `context.target`). */
type InvocationConfig = z.infer<typeof InvocationConfigSchema> & { server: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hookMatches(def: InterceptorDefinition, event: string, phase?: string): boolean {
  return def.hooks.some(
    (h) => (phase === undefined || h.phase === phase) && (h.events.includes(event) || h.events.includes("*")),
  );
}

export interface AdtlInterceptorsOptions {
  config: AdtlConfig;
  sessions?: SessionStore;
  /** Label ledger shared with other ADTL processes. */
  ledger?: Ledger;
  /** Clock for durationMs; injectable for tests. */
  now?: () => number;
  /** Wall clock for confirmation expiry; injectable for tests. */
  clock?: () => Date;
  /** Key for confirmation tokens. Defaults to a random key per process. */
  confirmationSecret?: Buffer;
  /** How long a confirmation request stays valid. Longer than the gateway's longest approval wait (1 hour). */
  confirmationTtlMs?: number;
}

const CONFIRMATION_TOKEN_PREFIX = "adtlc1";
const DEFAULT_CONFIRMATION_TTL_MS = 2 * 60 * 60 * 1000;

export class AdtlInterceptors {
  readonly config: AdtlConfig;
  readonly sessions: SessionStore;
  readonly ledger: Ledger | undefined;
  private readonly now: () => number;
  private readonly clock: () => Date;
  private readonly secret: Buffer;
  private readonly ttlMs: number;
  /** Confirmation ids already used, with their expiry (ms), so each one allows one call. */
  private readonly usedConfirmations = new Map<string, number>();

  constructor(options: AdtlInterceptorsOptions) {
    this.config = options.config;
    this.sessions = options.sessions ?? new InMemorySessionStore();
    this.ledger = options.ledger;
    this.now = options.now ?? (() => performance.now());
    this.clock = options.clock ?? (() => new Date());
    this.secret = options.confirmationSecret ?? randomBytes(32);
    this.ttlMs = options.confirmationTtlMs ?? DEFAULT_CONFIRMATION_TTL_MS;
  }

  /** Interceptor definitions, optionally filtered to those hooking `event`. */
  list(event?: string): InterceptorDefinition[] {
    const defs = event === undefined ? DEFINITIONS : DEFINITIONS.filter((d) => hookMatches(d, event));
    return structuredClone(defs);
  }

  /** Events declared in `capabilities.extensions["io.modelcontextprotocol/interceptors"].supportedEvents`. */
  supportedEvents(): string[] {
    return [...new Set(DEFINITIONS.flatMap((d) => d.hooks.flatMap((h) => h.events)))];
  }

  invoke(params: InvocationParams): InterceptorResult {
    const def = DEFINITIONS.find((d) => d.name === params.name);
    if (!def) {
      throw new InterceptorError(ErrorCodes.InvalidParams, `Unknown interceptor: ${params.name}`, {
        interceptor: params.name,
        available: DEFINITIONS.map((d) => d.name),
      });
    }
    if (!hookMatches(def, params.event, params.phase)) {
      throw new InterceptorError(
        ErrorCodes.InvalidParams,
        `${def.name} does not hook ${params.event} at the ${params.phase} phase`,
        { interceptor: def.name, event: params.event, phase: params.phase },
      );
    }
    const parsed = InvocationConfigSchema.safeParse(params.config ?? {});
    if (!parsed.success) {
      throw new InterceptorError(ErrorCodes.InvalidParams, `Invalid config for ${def.name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ")}`, {
        interceptor: def.name,
      });
    }

    // SEP-2624: without config, an interceptor uses its defaults. The upstream defaults to the invocation's target.
    const server = parsed.data.server ?? params.context?.target;
    if (server === undefined) {
      throw new InterceptorError(ErrorCodes.InvalidParams, `${def.name} needs the upstream server: set config.server or context.target`, {
        interceptor: def.name,
      });
    }
    const config: InvocationConfig = { ...parsed.data, server };

    const started = this.now();
    const result =
      def.name === POLICY_INTERCEPTOR
        ? this.policy(params, config)
        : params.phase === "request"
          ? this.stamp(params, config)
          : this.label(params, config);
    result.durationMs = Math.max(0, Math.round((this.now() - started) * 1000) / 1000);
    return result;
  }

  /**
   * Request phase: stamp the session label into the argument named by the
   * tool's `labelInto`, and scope a tainted session's write by `scopeInto`.
   */
  private stamp(params: InvocationParams, config: InvocationConfig): MutationResult {
    const payload = isRecord(params.payload) ? params.payload : {};
    const wrapped = isRecord(payload.params);
    const rpcParams = wrapped ? (payload.params as Record<string, unknown>) : payload;
    const tool = typeof rpcParams.name === "string" ? rpcParams.name : config.tool;
    const rule = tool === undefined ? undefined : this.config.servers[config.server]?.tools[tool];
    const field = rule?.labelInto;
    const scopeField = rule?.scopeInto;
    const unchanged: MutationResult = { interceptor: LABEL_INTERCEPTOR, type: "mutation", phase: params.phase, modified: false, payload: params.payload };
    if (field === undefined && scopeField === undefined) return unchanged;

    const sessionId = params.context?.sessionId;
    if (!sessionId) return { ...unchanged, info: { warning: "No context.sessionId: the record was not stamped or scoped" } };
    const label = this.sessions.get(sessionId);
    let args = isRecord(rpcParams.arguments) ? rpcParams.arguments : {};
    try {
      if (field !== undefined) args = stampRecordLabel(args, field, label, sessionId);
      if (scopeField !== undefined) args = scopeRecord(args, scopeField, label);
    } catch (err) {
      throw new InterceptorError(ErrorCodes.InvalidParams, `${LABEL_INTERCEPTOR}: ${(err as Error).message}`, { interceptor: LABEL_INTERCEPTOR });
    }
    if (args === rpcParams.arguments) return unchanged;
    const next = { ...rpcParams, arguments: args };
    return {
      ...unchanged,
      modified: true,
      payload: wrapped ? { ...payload, params: next } : next,
      info: {
        ...(field !== undefined ? { stamped: field } : {}),
        ...(scopeField !== undefined && args[scopeField] !== undefined ? { scope: args[scopeField] } : {}),
      },
    };
  }

  private label(params: InvocationParams, config: InvocationConfig): MutationResult {
    // Accept either the full exchange { method, params, result } or a bare result.
    const wrapped = isRecord(params.payload) && "result" in params.payload;
    const rpcParams = wrapped && isRecord((params.payload as Record<string, unknown>).params)
      ? ((params.payload as Record<string, unknown>).params as Record<string, unknown>)
      : undefined;
    const result = wrapped ? (params.payload as Record<string, unknown>).result : params.payload;

    if (!isRecord(result)) {
      throw new InterceptorError(ErrorCodes.InvalidParams, `${LABEL_INTERCEPTOR} expects the result to be an object`, {
        interceptor: LABEL_INTERCEPTOR,
      });
    }

    let tool: string | undefined;
    let resource: string | undefined;
    let prompt: string | undefined;
    if (params.event === "prompts/get") {
      prompt = typeof rpcParams?.name === "string" ? rpcParams.name : config.prompt;
    } else if (params.event === "tools/call") {
      tool = typeof rpcParams?.name === "string" ? rpcParams.name : config.tool;
      if (tool === undefined) {
        throw new InterceptorError(
          ErrorCodes.InvalidParams,
          `${LABEL_INTERCEPTOR} needs the tool name: pass the payload as { params: { name }, result } or set config.tool`,
          { interceptor: LABEL_INTERCEPTOR },
        );
      }
    } else {
      resource = typeof rpcParams?.uri === "string" ? rpcParams.uri : config.resource;
    }

    let label = labelResult(
      {
        server: config.server,
        ...(tool !== undefined ? { tool } : {}),
        ...(resource !== undefined ? { resource } : {}),
        ...(prompt !== undefined ? { prompt } : {}),
        result,
        ...(config.toolAnnotations ? { toolAnnotations: config.toolAnnotations } : {}),
      },
      this.config,
    );

    const info: Record<string, unknown> = {};
    const server = this.config.servers[config.server];
    if (tool !== undefined && (server?.tools[tool]?.readLabels ?? server?.defaults?.readLabels)) {
      const carried = readRecordLabels(result, this.config.defaults);
      if (carried) {
        label = join(label, carried.label);
        info.records = { stamps: carried.records, writers: carried.writers };
      }
    }
    if (this.ledger) {
      const match = this.ledger.lookup(valueHashes(result));
      if (match) {
        label = join(label, match.label);
        info.ledger = { chunks: match.chunks, writers: match.writers };
      }
    }
    info.label = label;

    const sessionId = params.context?.sessionId;
    if (sessionId) {
      // What the call sent was produced by the session as it was before this result.
      const before = this.sessions.get(sessionId);
      const sent = rpcParams?.arguments;
      if (this.ledger && sent !== undefined) {
        const source = { server: config.server, ...(tool !== undefined ? { tool } : {}), ...(prompt !== undefined ? { prompt } : {}) };
        this.ledger.record(valueHashes(sent), before, sessionId, source);
      }
      info.sessionLabel = this.sessions.observe(sessionId, label);
    } else {
      info.warning = "No context.sessionId: the result was labeled but not recorded in any session";
    }

    const labeled = attachLabel(result, label);
    return {
      interceptor: LABEL_INTERCEPTOR,
      type: "mutation",
      phase: params.phase,
      modified: true,
      payload: wrapped ? { ...(params.payload as Record<string, unknown>), result: labeled } : labeled,
      info,
    };
  }

  private policy(params: InvocationParams, config: InvocationConfig): ValidationResult {
    // Accept either the JSON-RPC request { method, params } or bare params { name, arguments }.
    const payload = isRecord(params.payload) ? params.payload : {};
    const rpcParams = isRecord(payload.params) ? payload.params : payload;
    const tool = typeof rpcParams.name === "string" ? rpcParams.name : config.tool;
    if (tool === undefined) {
      throw new InterceptorError(
        ErrorCodes.InvalidParams,
        `${POLICY_INTERCEPTOR} needs the tool name: pass the payload as { params: { name, arguments } } or set config.tool`,
        { interceptor: POLICY_INTERCEPTOR },
      );
    }
    const hash = callBindingHash({
      event: params.event,
      phase: params.phase,
      target: params.context?.target ?? null,
      payload: params.payload,
    });

    const sessionId = params.context?.sessionId;
    if (!sessionId) {
      // Fail closed: without a session we cannot know what the agent has already seen.
      return this.decision(params, "block", "No context.sessionId: cannot check this call against the session's labels", [], hash);
    }

    const session = this.sessions.get(sessionId);
    const d = evaluatePolicy(this.config.policy, {
      session,
      server: config.server,
      tool,
      egress: toolEgress(this.config, config.server, tool),
    });
    if (d.decision !== "ask") return this.decision(params, d.decision, d.reason, d.matched, hash, session);

    const extra: Record<string, unknown> = {};
    if (params.context?.confirmations?.length) {
      const confirmed = this.acceptConfirmation(params, hash, sessionId);
      if (typeof confirmed !== "string") {
        extra.confirmed = confirmed;
        return this.decision(params, "allow", `Confirmed by a human: ${d.reason}`, d.matched, hash, session, extra);
      }
      extra.confirmationRejected = confirmed;
    }
    // Who may answer: the gateway reaches only these roles' members.
    if (d.approvers) extra.approvers = d.approvers;
    const confirmation = this.confirmationRequest(d.reason, hash, sessionId);
    return this.decision(params, "ask", d.reason, d.matched, hash, session, extra, confirmation);
  }

  private confirmationRequest(reason: string, hash: string, sessionId: string): ConfirmationRequest {
    const id = randomUUID();
    const exp = Math.floor((this.clock().getTime() + this.ttlMs) / 1000);
    const token = `${CONFIRMATION_TOKEN_PREFIX}.${exp}.${this.mac(id, hash, sessionId, exp)}`;
    return { id, reason, callHash: hash, expiresAt: new Date(exp * 1000).toISOString(), token };
  }

  /**
   * Accept a confirmation for this exact call binding and session, issued by
   * this server, unexpired and not used before. Returns why it was rejected otherwise.
   */
  private acceptConfirmation(params: InvocationParams, hash: string, sessionId: string): Record<string, unknown> | string {
    const c = params.context!.confirmations!.find((x) => x.interceptor === POLICY_INTERCEPTOR);
    if (!c) return `no confirmation from ${POLICY_INTERCEPTOR}`;
    if (c.callHash !== hash) return "the confirmation is for a different call";
    const parts = (c.token ?? "").split(".");
    if (parts.length !== 3 || parts[0] !== CONFIRMATION_TOKEN_PREFIX || !/^\d+$/.test(parts[1]!)) return "invalid token";
    const exp = Number(parts[1]);
    const expected = Buffer.from(this.mac(c.id, hash, sessionId, exp));
    const given = Buffer.from(parts[2]!);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "invalid token";
    const now = this.clock().getTime();
    if (now > exp * 1000) return "the confirmation has expired";
    for (const [id, until] of this.usedConfirmations) if (until < now) this.usedConfirmations.delete(id);
    if (this.usedConfirmations.has(c.id)) return "the confirmation was already used";
    this.usedConfirmations.set(c.id, exp * 1000);
    return { id: c.id, decidedAt: c.decidedAt, ...(c.principal ? { principal: c.principal } : {}) };
  }

  private mac(id: string, hash: string, sessionId: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`${id}\n${hash}\n${sessionId}\n${exp}`).digest("base64url");
  }

  private decision(
    params: InvocationParams,
    decision: Decision,
    reason: string,
    matched: string[],
    hash: string,
    session?: Label,
    extra: Record<string, unknown> = {},
    confirmation?: ConfirmationRequest,
  ): ValidationResult {
    const allowed = decision === "allow";
    const info: Record<string, unknown> = { [DECISION_INFO_KEY]: decision, reason, matched, callHash: hash, ...extra };
    if (session) info.sessionLabel = session;
    return {
      interceptor: POLICY_INTERCEPTOR,
      type: "validation",
      phase: params.phase,
      valid: allowed,
      severity: allowed ? "info" : "error",
      ...(allowed ? {} : { messages: [{ path: "params.name", message: reason, severity: "error" as const }] }),
      ...(confirmation ? { confirmation } : {}),
      info,
    };
  }
}
