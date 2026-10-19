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
 * with the stored record. Results of tools with `readLabels` are joined with
 * the stamps they carry (stricter only). See @adtl/labels recordLabel.
 *
 * With a ledger, `adtl.label` also re-labels content that a tainted session
 * wrote earlier (looked up by content hash), and records the text of the
 * call's arguments when the session is tainted, so the label follows that
 * text into files, memory servers and other agents.
 *
 * Both share one SessionStore keyed by `context.sessionId`. Sharing state
 * between interceptor calls is listed as "Future" in SEP-2624, so ADTL keeps it
 * inside this interceptor server for now.
 *
 * Per-invocation `config` (set by the invoker, e.g. adtl-gateway):
 *   server          upstream MCP server id, as named in the ADTL config (required)
 *   tool            tool name, if the payload does not carry it
 *   resource        resource URI, if the payload does not carry it
 *   prompt          prompt name, if the payload does not carry it
 *   toolAnnotations MCP tool annotations from tools/list, e.g. { openWorldHint: true }
 */
import {
  InMemorySessionStore,
  attachLabel,
  join,
  callHash,
  evaluatePolicy,
  labelResult,
  readRecordLabels,
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
  InterceptorDefinition,
  InterceptorResult,
  InvocationParams,
  MutationResult,
  ValidationResult,
} from "./types.js";

export const LABEL_INTERCEPTOR = "adtl.label";
export const POLICY_INTERCEPTOR = "adtl.policy";

/** Key in `ValidationResult.info` carrying ADTL's decision (SEP-2624 has no "ask" outcome yet). */
export const DECISION_INFO_KEY = "adtl/decision";

export const VERSION = "0.4.0";

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
    server: { type: "string", description: "Upstream MCP server id, as named in the ADTL config" },
    tool: { type: "string", description: "Tool name, if the payload does not carry it" },
    resource: { type: "string", description: "Resource URI, if the payload does not carry it" },
    prompt: { type: "string", description: "Prompt name, if the payload does not carry it" },
    toolAnnotations: { type: "object", description: "MCP tool annotations from tools/list" },
  },
  required: ["server"],
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
    server: z.string().min(1),
    tool: z.string().min(1).optional(),
    resource: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    toolAnnotations: z.object({ openWorldHint: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();
type InvocationConfig = z.infer<typeof InvocationConfigSchema>;

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
}

export class AdtlInterceptors {
  readonly config: AdtlConfig;
  readonly sessions: SessionStore;
  readonly ledger: Ledger | undefined;
  private readonly now: () => number;

  constructor(options: AdtlInterceptorsOptions) {
    this.config = options.config;
    this.sessions = options.sessions ?? new InMemorySessionStore();
    this.ledger = options.ledger;
    this.now = options.now ?? (() => performance.now());
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

    const started = this.now();
    const result =
      def.name === POLICY_INTERCEPTOR
        ? this.policy(params, parsed.data)
        : params.phase === "request"
          ? this.stamp(params, parsed.data)
          : this.label(params, parsed.data);
    result.durationMs = Math.max(0, Math.round((this.now() - started) * 1000) / 1000);
    return result;
  }

  /** Request phase: stamp the session label into the argument named by the tool's `labelInto`. */
  private stamp(params: InvocationParams, config: InvocationConfig): MutationResult {
    const payload = isRecord(params.payload) ? params.payload : {};
    const wrapped = isRecord(payload.params);
    const rpcParams = wrapped ? (payload.params as Record<string, unknown>) : payload;
    const tool = typeof rpcParams.name === "string" ? rpcParams.name : config.tool;
    const field = tool === undefined ? undefined : this.config.servers[config.server]?.tools[tool]?.labelInto;
    const unchanged: MutationResult = { interceptor: LABEL_INTERCEPTOR, type: "mutation", phase: params.phase, modified: false, payload: params.payload };
    if (field === undefined) return unchanged;

    const sessionId = params.context?.sessionId;
    if (!sessionId) return { ...unchanged, info: { warning: "No context.sessionId: the record was not stamped" } };
    const args = isRecord(rpcParams.arguments) ? rpcParams.arguments : {};
    let stamped: Record<string, unknown>;
    try {
      stamped = stampRecordLabel(args, field, this.sessions.get(sessionId), sessionId);
    } catch (err) {
      throw new InterceptorError(ErrorCodes.InvalidParams, `${LABEL_INTERCEPTOR}: ${(err as Error).message}`, { interceptor: LABEL_INTERCEPTOR });
    }
    const next = { ...rpcParams, arguments: stamped };
    return {
      ...unchanged,
      modified: true,
      payload: wrapped ? { ...payload, params: next } : next,
      info: { stamped: field },
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
    const args = rpcParams.arguments ?? {};
    const hash = callHash(config.server, tool, args);

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
    return this.decision(params, d.decision, d.reason, d.matched, hash, session);
  }

  private decision(
    params: InvocationParams,
    decision: Decision,
    reason: string,
    matched: string[],
    hash: string,
    session?: Label,
  ): ValidationResult {
    const allowed = decision === "allow";
    const info: Record<string, unknown> = { [DECISION_INFO_KEY]: decision, reason, matched, callHash: hash };
    if (session) info.sessionLabel = session;
    return {
      interceptor: POLICY_INTERCEPTOR,
      type: "validation",
      phase: params.phase,
      valid: allowed,
      severity: allowed ? "info" : "error",
      ...(allowed ? {} : { messages: [{ path: "params.name", message: reason, severity: "error" as const }] }),
      info,
    };
  }
}
