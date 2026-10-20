/**
 * Wire types for the MCP interceptors extension, mirroring the SEP-2624 draft
 * (modelcontextprotocol/experimental-ext-interceptors, docs/sep.md).
 *
 * Kept in one small module so it can be swapped for the official
 * `@ext-modelcontextprotocol/interceptors` package once that is published.
 */
import { z } from "zod";

/** Capability key servers declare under `capabilities.extensions`. */
export const INTERCEPTORS_EXTENSION = "io.modelcontextprotocol/interceptors";

export const LIST_METHOD = "interceptors/list";
export const INVOKE_METHOD = "interceptor/invoke";

/** Lifecycle event, e.g. "tools/call". The draft allows custom events. */
export type InterceptionEvent = string;
export type Phase = "request" | "response";
export type Severity = "info" | "warn" | "error";

export interface InterceptorHook {
  events: InterceptionEvent[];
  phase: Phase;
}

export interface InterceptorDefinition {
  name: string;
  version?: string;
  description?: string;
  type: "validation" | "mutation";
  hooks: InterceptorHook[];
  mode?: "active" | "audit";
  failOpen?: boolean;
  priorityHint?: number | { request?: number; response?: number };
  compat?: { minProtocol: string; maxProtocol?: string };
  configSchema?: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface InvocationContext {
  principal?: { type: "user" | "service" | "anonymous"; id?: string; claims?: Record<string, unknown> };
  traceId?: string;
  spanId?: string;
  timestamp?: string;
  sessionId?: string;
  /** Peer the payload is sent to or, when receiving, came from (e.g. a server name). Part of the call binding. */
  target?: string;
  /** Human confirmations for this exact payload, set when the invoker re-invokes a validator after asking. */
  confirmations?: Confirmation[];
}

/** A validator's request for human confirmation (SEP-2624 draft, experimental-ext-interceptors#45). */
export interface ConfirmationRequest {
  id: string;
  reason: string;
  /** Hash of the call binding { event, phase, target, payload }. */
  callHash: string;
  expiresAt?: string;
  /** Opaque; the invoker returns it unchanged. */
  token?: string;
}

export interface Confirmation {
  /** Name of the validator that requested it. */
  interceptor: string;
  id: string;
  callHash: string;
  token?: string;
  decidedAt: string;
  principal?: { type: "user" | "service"; id?: string };
}

export interface InvocationParams {
  name: string;
  event: InterceptionEvent;
  phase: Phase;
  payload: unknown;
  config?: Record<string, unknown>;
  timeoutMs?: number;
  context?: InvocationContext;
}

export interface ValidationMessage {
  path?: string;
  message: string;
  severity: Severity;
}

interface ResultBase {
  interceptor: string;
  phase: Phase;
  durationMs?: number;
  info?: Record<string, unknown>;
}

export interface ValidationResult extends ResultBase {
  type: "validation";
  valid: boolean;
  severity?: Severity;
  messages?: ValidationMessage[];
  /** Set with valid: false and severity: "error": the payload may proceed only if a human confirms it. */
  confirmation?: ConfirmationRequest;
}

export interface MutationResult extends ResultBase {
  type: "mutation";
  modified: boolean;
  payload: unknown;
}

export type InterceptorResult = ValidationResult | MutationResult;

const PhaseSchema = z.enum(["request", "response"]);

export const InvocationParamsSchema = z
  .object({
    name: z.string().min(1),
    event: z.string().min(1),
    phase: PhaseSchema,
    payload: z.unknown(),
    config: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().positive().optional(),
    context: z
      .object({
        principal: z
          .object({
            type: z.enum(["user", "service", "anonymous"]),
            id: z.string().optional(),
            claims: z.record(z.unknown()).optional(),
          })
          .passthrough()
          .optional(),
        traceId: z.string().optional(),
        spanId: z.string().optional(),
        timestamp: z.string().optional(),
        sessionId: z.string().optional(),
        target: z.string().optional(),
        confirmations: z
          .array(
            z
              .object({
                interceptor: z.string(),
                id: z.string(),
                callHash: z.string(),
                token: z.string().optional(),
                decidedAt: z.string(),
                principal: z.object({ type: z.enum(["user", "service"]), id: z.string().optional() }).passthrough().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const ListRequestSchema = z.object({
  method: z.literal(LIST_METHOD),
  params: z.object({ event: z.string().optional() }).passthrough().optional(),
});

/**
 * Params are validated by the handler (against InvocationParamsSchema) rather
 * than here, so malformed requests get a proper -32602 Invalid params error.
 */
export const InvokeRequestSchema = z.object({
  method: z.literal(INVOKE_METHOD),
  params: z.unknown().optional(),
});
