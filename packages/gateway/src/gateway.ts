/**
 * The gateway: one MCP server facing the agent, many MCP clients facing the
 * upstream servers, and an interceptor chain in between.
 *
 * tools/list  → every upstream's tools, renamed <upstream>__<tool>
 * tools/call  → request interceptors (adtl.policy) → upstream → response
 *               interceptors (adtl.label) → agent
 *
 * When a call is stopped, the agent receives a normal tool result with
 * `isError: true` explaining why, so the model can tell the user.
 *
 * An "ask" decision holds the call and asks a human through the approval
 * broker (e.g. a phone notification). Approved calls run; denied, unanswered
 * or undeliverable ones are stopped. Without an approval channel, "ask" blocks.
 *
 * In audit mode (the invoker runs every interceptor with `mode: "audit"`)
 * nothing is stopped or changed: calls the policy would stop are forwarded,
 * and the audit log records what would have happened.
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
import type { ApprovalBroker, ApprovalResult } from "./approvals.js";
import type { AuditEntry, AuditSink } from "./audit.js";
import { TOOL_SEPARATOR } from "./config.js";
import type { Blocked, ChainOutcome, InterceptorInvoker } from "./invoker.js";

export const GATEWAY_VERSION = "0.1.1";

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
  /** Asks humans about "ask" decisions and sends notices. */
  approvals?: ApprovalBroker;
}

export interface CallOptions {
  /** Report progress to the client while a call waits for approval. */
  progress?: (progress: number, message: string) => Promise<void>;
}

/** How often a waiting call reports progress, so clients that reset their timeout on progress keep waiting. */
const PROGRESS_INTERVAL_MS = 10_000;

function textError(text: string, meta: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], isError: true, _meta: { [GATEWAY_DECISION_KEY]: meta } };
}

function blockedMessage(b: Blocked): string {
  if (b.decision === "ask") {
    return (
      `ADTL stopped this call because it needs a human's approval: ${b.reason}. ` +
      `No approval channel is configured, so the call was not run. Tell the user what you were trying to do.`
    );
  }
  return `ADTL blocked this call: ${b.reason}. The call was not run.`;
}

function approvalMessage(b: Blocked, a: ApprovalResult): string {
  const why = `ADTL asked a human to approve this call because: ${b.reason}.`;
  switch (a.outcome) {
    case "denied":
      return `${why} The request was denied, so the call was not run. Do not retry it; tell the user what you were trying to do.`;
    case "timeout":
      return `${why} Nobody answered in time, so the call was not run. Tell the user, who can approve it if you try again.`;
    default:
      return `${why} ADTL could not reach anyone to approve it, so the call was not run. Tell the user what you were trying to do.`;
  }
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
  private readonly approvals: ApprovalBroker | undefined;
  private routes = new Map<string, Route>();

  constructor(opts: AdtlGatewayOptions) {
    this.upstreams = opts.upstreams;
    this.invoker = opts.invoker;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.audit = opts.audit;
    this.log = opts.logger ?? stderrLogger;
    this.approvals = opts.approvals;
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
    server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const progressToken = req.params._meta?.progressToken;
      const progress =
        progressToken === undefined
          ? undefined
          : (progress: number, message: string) =>
              extra.sendNotification({ method: "notifications/progress", params: { progressToken, progress, message } });
      return this.callTool(req.params.name, req.params.arguments ?? {}, progress ? { progress } : {});
    });
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

  async callTool(name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallToolResult> {
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
    let approval: ApprovalResult | undefined;
    if (req.blocked) {
      const b = req.blocked;
      const stopped = { decision: b.decision, reason: b.reason, matched: policy.matched, callHash: policy.callHash, sessionLabel: policy.sessionLabel };
      const matched = Array.isArray(policy.matched) ? (policy.matched as string[]) : [];
      if (b.decision === "ask" && this.approvals?.canApprove && typeof policy.callHash === "string") {
        this.log.info(`ask ${name}: waiting for approval (${b.reason})`);
        approval = await this.waitForApproval(opts, () =>
          this.approvals!.request({
            sessionId: this.sessionId,
            server: route.upstream,
            tool: route.tool,
            callHash: policy.callHash as string,
            reason: b.reason,
            matched,
            ...(policy.sessionLabel !== undefined ? { sessionLabel: policy.sessionLabel } : {}),
          }),
        );
        this.log.info(`ask ${name}: ${approval.outcome}`);
        if (approval.outcome !== "approved") {
          finish({ outcome: "blocked", ...stopped, approval, warnings: req.warnings });
          return textError(approvalMessage(b, approval), { ...b, callHash: policy.callHash, approval });
        }
      } else {
        finish({ outcome: "blocked", ...stopped, warnings: req.warnings });
        this.log.info(`${b.decision} ${name}: ${b.reason}`);
        this.approvals?.blocked({ sessionId: this.sessionId, server: route.upstream, tool: route.tool, reason: b.reason, matched });
        return textError(blockedMessage(b), { ...b, callHash: policy.callHash });
      }
    }
    const forwarded = (req.payload as typeof requestPayload).params;
    const decision = policy["adtl/decision"] as string | undefined;
    const approved = approval ? { approval } : {};
    const audit = this.invoker.modeOverride === "audit";
    // Only set in audit mode, for calls the policy would have stopped.
    const wouldStop =
      audit && decision !== undefined && decision !== "allow"
        ? { reason: policy.reason as string | undefined, matched: policy.matched }
        : undefined;
    if (wouldStop) this.log.info(`audit: would ${decision} ${name}: ${wouldStop.reason}`);

    // 2. Forward to the upstream server.
    let result: CallToolResult;
    try {
      result = (await client.callTool({ name: forwarded.name, arguments: forwarded.arguments })) as CallToolResult;
    } catch (err) {
      const reason = (err as Error).message;
      finish({ outcome: "upstream_error", ...(decision ? { decision } : {}), ...approved, reason, callHash: policy.callHash, ...(audit ? { mode: "audit" as const } : {}), warnings: req.warnings });
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
      // Missing only if adtl.policy failed and was allowed to (audit mode); see warnings.
      ...(decision ? { decision } : {}),
      ...(wouldStop ?? {}),
      ...approved,
      ...(audit ? { mode: "audit" as const } : {}),
      callHash: policy.callHash,
      label: label.label,
      sessionLabel: label.sessionLabel,
      warnings: [...req.warnings, ...res.warnings],
    });
    return (res.payload as { result: CallToolResult }).result;
  }

  /** Run an approval request, reporting progress to the client while it waits. */
  private async waitForApproval(opts: CallOptions, ask: () => Promise<ApprovalResult>): Promise<ApprovalResult> {
    if (!opts.progress) return ask();
    let n = 0;
    const report = () => void opts.progress!(++n, "Waiting for a human to approve this call").catch(() => undefined);
    report();
    const timer = setInterval(report, PROGRESS_INTERVAL_MS);
    try {
      return await ask();
    } finally {
      clearInterval(timer);
    }
  }
}
