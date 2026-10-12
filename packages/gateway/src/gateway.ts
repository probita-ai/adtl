/**
 * The gateway: one MCP server facing the agent, many MCP clients facing the
 * upstream servers, and an interceptor chain in between.
 *
 * tools/list  → every upstream's tools, renamed <upstream>__<tool>
 * tools/call  → request interceptors (adtl.policy) → upstream → response
 *               interceptors (adtl.label) → agent
 *
 * When a call is stopped, the agent receives a normal tool result with
 * `isError: true` explaining why, so the model can tell the user. In v0.1 an
 * "ask" decision is treated as a block; approvals arrive in v0.2.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { InvocationContext } from "@adtl/interceptors";
import type { AuditEntry, AuditSink } from "./audit.js";
import { TOOL_SEPARATOR } from "./config.js";
import type { Blocked, ChainOutcome, InterceptorInvoker } from "./invoker.js";

export const GATEWAY_VERSION = "0.1.0";

/** `_meta` key on gateway-generated error results describing why a call was stopped. */
export const GATEWAY_DECISION_KEY = "adtl/gateway";

interface Route {
  upstream: string;
  tool: string;
  annotations?: Tool["annotations"];
}

export interface GatewayLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const stderrLogger: GatewayLogger = {
  info: (m) => console.error(`[adtl-gateway] ${m}`),
  warn: (m) => console.error(`[adtl-gateway] warning: ${m}`),
};

export interface AdtlGatewayOptions {
  upstreams: Map<string, Client>;
  invoker: InterceptorInvoker;
  /** One gateway process serves one agent session over stdio. */
  sessionId?: string;
  audit?: AuditSink;
  logger?: GatewayLogger;
}

function textError(text: string, meta: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], isError: true, _meta: { [GATEWAY_DECISION_KEY]: meta } };
}

function blockedMessage(b: Blocked): string {
  if (b.decision === "ask") {
    return (
      `ADTL stopped this call because it needs a human's approval: ${b.reason}. ` +
      `This version of ADTL cannot ask for approval yet, so the call was not run. Tell the user what you were trying to do.`
    );
  }
  return `ADTL blocked this call: ${b.reason}. The call was not run.`;
}

function infoOf(outcome: ChainOutcome, interceptor: string): Record<string, unknown> {
  return outcome.results.find((r) => r.interceptor === interceptor)?.info ?? {};
}

export class AdtlGateway {
  readonly sessionId: string;
  private readonly upstreams: Map<string, Client>;
  private readonly invoker: InterceptorInvoker;
  private readonly audit: AuditSink | undefined;
  private readonly log: GatewayLogger;
  private routes = new Map<string, Route>();

  constructor(opts: AdtlGatewayOptions) {
    this.upstreams = opts.upstreams;
    this.invoker = opts.invoker;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.audit = opts.audit;
    this.log = opts.logger ?? stderrLogger;
  }

  /** The downstream MCP server the agent connects to. */
  createServer(): Server {
    const server = new Server(
      { name: "adtl-gateway", version: GATEWAY_VERSION },
      {
        capabilities: { tools: {} },
        instructions:
          "Tools from several MCP servers, named <server>__<tool>. ADTL checks each call against trust labels; " +
          "if a call is stopped, the result explains why.",
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => this.callTool(req.params.name, req.params.arguments ?? {}));
    return server;
  }

  async listTools(): Promise<Tool[]> {
    const routes = new Map<string, Route>();
    const tools: Tool[] = [];
    for (const [upstream, client] of this.upstreams) {
      let cursor: string | undefined;
      try {
        do {
          const page = await client.listTools(cursor ? { cursor } : {});
          for (const t of page.tools) {
            const name = `${upstream}${TOOL_SEPARATOR}${t.name}`;
            routes.set(name, { upstream, tool: t.name, ...(t.annotations ? { annotations: t.annotations } : {}) });
            tools.push({ ...t, name });
          }
          cursor = page.nextCursor;
        } while (cursor);
      } catch (err) {
        this.log.warn(`tools/list failed for ${upstream}: ${(err as Error).message}`);
      }
    }
    this.routes = routes;
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const started = performance.now();
    let route = this.routes.get(name);
    if (!route) {
      await this.listTools();
      route = this.routes.get(name);
    }
    if (!route) return textError(`Unknown tool: ${name}`, { reason: "unknown_tool" });

    const client = this.upstreams.get(route.upstream)!;
    const context: InvocationContext = {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      principal: { type: "anonymous" },
    };
    const config: Record<string, unknown> = {
      server: route.upstream,
      ...(route.annotations ? { toolAnnotations: route.annotations } : {}),
    };
    const base = { sessionId: this.sessionId, event: "tools/call" as const, server: route.upstream, tool: route.tool };
    const finish = (entry: Omit<AuditEntry, keyof typeof base | "ts" | "durationMs">) =>
      this.audit?.write({ ts: context.timestamp!, ...base, ...entry, durationMs: Math.round(performance.now() - started) });

    // 1. Request phase: adtl.policy decides whether the call may run.
    const requestPayload = { method: "tools/call", params: { name: route.tool, arguments: args } };
    const req = await this.invoker.runRequest({ event: "tools/call", payload: requestPayload, config, context });
    const policy = infoOf(req, "adtl.policy");
    if (req.blocked) {
      finish({ outcome: "blocked", decision: req.blocked.decision, reason: req.blocked.reason, matched: policy.matched, callHash: policy.callHash, sessionLabel: policy.sessionLabel, warnings: req.warnings });
      this.log.info(`${req.blocked.decision} ${name}: ${req.blocked.reason}`);
      return textError(blockedMessage(req.blocked), { ...req.blocked, callHash: policy.callHash });
    }
    const forwarded = (req.payload as typeof requestPayload).params;

    // 2. Forward to the upstream server.
    let result: CallToolResult;
    try {
      result = (await client.callTool({ name: forwarded.name, arguments: forwarded.arguments })) as CallToolResult;
    } catch (err) {
      const reason = (err as Error).message;
      finish({ outcome: "upstream_error", decision: "allow", reason, callHash: policy.callHash, warnings: req.warnings });
      return textError(`The ${route.upstream} server returned an error: ${reason}`, { reason: "upstream_error" });
    }

    // 3. Response phase: adtl.label labels the result and records it in the session.
    const res = await this.invoker.runResponse({
      event: "tools/call",
      payload: { method: "tools/call", params: forwarded, result },
      config,
      context,
    });
    if (res.blocked) {
      // Fail closed: an unlabeled result must not reach the agent.
      finish({ outcome: "blocked", decision: res.blocked.decision, reason: res.blocked.reason, callHash: policy.callHash, warnings: [...req.warnings, ...res.warnings] });
      this.log.warn(`result of ${name} withheld: ${res.blocked.reason}`);
      return textError(`ADTL could not label the result of this call, so it was withheld: ${res.blocked.reason}`, { ...res.blocked });
    }
    const label = infoOf(res, "adtl.label");
    finish({
      outcome: "forwarded",
      decision: (policy["adtl/decision"] as string | undefined) ?? "allow",
      callHash: policy.callHash,
      label: label.label,
      sessionLabel: label.sessionLabel,
      warnings: [...req.warnings, ...res.warnings],
    });
    return (res.payload as { result: CallToolResult }).result;
  }
}
