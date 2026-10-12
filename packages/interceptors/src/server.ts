/**
 * Expose AdtlInterceptors as an MCP Interceptor Server over any MCP transport.
 *
 * Per the Interceptors WG, an Interceptor Server offers interceptors only (no
 * tools, prompts or resources) and declares the extension capability.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { AdtlInterceptors, ErrorCodes, InterceptorError, VERSION } from "./adtlInterceptors.js";
import {
  INTERCEPTORS_EXTENSION,
  InvocationParamsSchema,
  InvokeRequestSchema,
  ListRequestSchema,
  type InvocationParams,
} from "./types.js";

type LooseHandler = (request: { params?: unknown }) => unknown;

/**
 * Register a handler for an extension method. The SDK's typed
 * `setRequestHandler` only accepts standard MCP result types, so extension
 * methods are registered through this untyped view of the same call.
 */
function onRequest(server: Server, schema: unknown, handler: LooseHandler): void {
  (server.setRequestHandler as unknown as (s: unknown, h: LooseHandler) => void).call(server, schema, handler);
}

export function createInterceptorServer(core: AdtlInterceptors): Server {
  const server = new Server(
    { name: "adtl-interceptors", version: VERSION },
    {
      capabilities: {
        extensions: {
          [INTERCEPTORS_EXTENSION]: { supportedEvents: core.supportedEvents() },
        },
      },
      instructions: "ADTL interceptor server: adtl.label labels tool results; adtl.policy checks tool calls against trust labels.",
    },
  );

  onRequest(server, ListRequestSchema, (request) => {
    const params = request.params as { event?: string } | undefined;
    return { interceptors: core.list(params?.event) };
  });

  onRequest(server, InvokeRequestSchema, (request) => {
    const parsed = InvocationParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "params"}: ${i.message}`).join("; ");
      throw new InterceptorError(ErrorCodes.InvalidParams, `Invalid interceptor/invoke params: ${problems}`);
    }
    // InterceptorError carries `code` and `data`, which the SDK puts on the JSON-RPC error as-is.
    // (McpError would prefix "MCP error <code>:" to the message, and the client prefixes it again.)
    return core.invoke(parsed.data as InvocationParams);
  });

  return server;
}
