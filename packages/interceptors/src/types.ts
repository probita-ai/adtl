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
