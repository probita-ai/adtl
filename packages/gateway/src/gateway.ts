/**
 * The gateway: one MCP server facing the agent, many MCP clients facing the
 * upstream servers, and an interceptor chain in between.
 *
 * tools/list  → every upstream's tools, renamed <upstream>__<tool>
 * tools/call  → request interceptors (adtl.policy) → upstream → response
 *               interceptors (adtl.label) → agent
 * prompts/*   → like tools: renamed <upstream>__<prompt>, results labeled
 * resources/* → URIs pass through unchanged and are routed to the upstream
 *               that lists them (or whose template matches). Results are
 *               labeled. A URI more than one upstream could serve is refused,
 *               since ADTL could not tell which server to label it as.
 *
 * When a call is stopped, the agent receives a normal tool result with
 * `isError: true` explaining why, so the model can tell the user.
 *
 * An "ask" decision holds the call and asks a human through the approval
 * broker (e.g. a phone notification). Approved calls run; denied, unanswered
 * or undeliverable ones are stopped. Without an approval channel, "ask" blocks.
 *
 * An optional Authorizer decides first whether the caller may use the tool,
 * resource or prompt at all; a denial stops the call before the policy runs.
 *
 * In audit mode (the invoker runs every interceptor with `mode: "audit"`)
 * nothing is stopped or changed: calls the policy would stop are forwarded,
 * and the audit log records what would have happened.
 */
import { randomUUID } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { InvocationContext } from "@adtl/interceptors";
import type { ApprovalBroker, ApprovalResult } from "./approvals.js";
import type { AuditEntry, AuditSink } from "./audit.js";
import { authorize, type AuthorizationRequest, type Authorizer, type Denial, type Principal } from "./authorizer.js";
import { TOOL_SEPARATOR } from "./config.js";
import type { Blocked, ChainOutcome, InterceptorInvoker } from "./invoker.js";

export const GATEWAY_VERSION = "0.4.0";

/** `_meta` key on gateway-generated error results describing why a call was stopped. */
export const GATEWAY_DECISION_KEY = "adtl/gateway";

interface Route {
  upstream: string;
  tool: string;
  annotations?: Tool["annotations"];
}

interface PromptRoute {
  upstream: string;
  prompt: string;
}

interface TemplateRoute {
  upstream: string;
  template: UriTemplate;
}

interface Page<T> {
  items: T[];
  nextCursor?: string | undefined;
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
  /** Decides whether the caller may use a tool, resource or prompt at all, before the policy. */
  authorizer?: Authorizer;
  /** The caller, passed to the authorizer and the interceptors. Default: anonymous. */
  principal?: Principal;
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
  private readonly authorizer: Authorizer | undefined;
  private readonly principal: Principal;
  private routes = new Map<string, Route>();
  private promptRoutes = new Map<string, PromptRoute>();
  /** Resource URI → the upstreams that list it. */
  private resourceRoutes = new Map<string, Set<string>>();
  private templateRoutes: TemplateRoute[] = [];

  constructor(opts: AdtlGatewayOptions) {
    this.upstreams = opts.upstreams;
    this.invoker = opts.invoker;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.audit = opts.audit;
    this.log = opts.logger ?? stderrLogger;
    this.approvals = opts.approvals;
    this.authorizer = opts.authorizer;
    this.principal = opts.principal ?? { type: "anonymous" };
  }

  /** Ask the authorizer, if any. Returns the denial; in audit mode the caller logs it and carries on. */
  private async authorize(request: Omit<AuthorizationRequest, "principal">): Promise<Denial | undefined> {
    return this.authorizer ? authorize(this.authorizer, { principal: this.principal, ...request }) : undefined;
  }

  /** The downstream MCP server the agent connects to. */
  createServer(): Server {
    // Offer resources and prompts only if some upstream does (the SDK refuses handlers for undeclared capabilities).
    const offers = (c: "resources" | "prompts") => [...this.upstreams.values()].some((u) => u.getServerCapabilities()?.[c]);
    const capabilities: ServerCapabilities = { tools: {} };
    if (offers("resources")) capabilities.resources = {};
    if (offers("prompts")) capabilities.prompts = {};
    const server = new Server(
      { name: "adtl-gateway", version: GATEWAY_VERSION },
      {
        capabilities,
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
    if (capabilities.resources) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await this.listResources() }));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
        resourceTemplates: await this.listResourceTemplates(),
      }));
      server.setRequestHandler(ReadResourceRequestSchema, async (req) => this.readResource(req.params.uri));
    }
    if (capabilities.prompts) {
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: await this.listPrompts() }));
      server.setRequestHandler(GetPromptRequestSchema, async (req) => this.getPrompt(req.params.name, req.params.arguments));
    }
    return server;
  }

  /** Every upstream's items from one list method, following cursors. Upstreams that fail are skipped with a warning. */
  private async listAll<T>(
    method: string,
    capability: "tools" | "resources" | "prompts",
    page: (client: Client, cursor?: string) => Promise<Page<T>>,
  ): Promise<{ upstream: string; item: T }[]> {
    const out: { upstream: string; item: T }[] = [];
    for (const [upstream, client] of this.upstreams) {
      if (capability !== "tools" && !client.getServerCapabilities()?.[capability]) continue;
      let cursor: string | undefined;
      try {
        do {
          const p = await page(client, cursor);
          for (const item of p.items) out.push({ upstream, item });
          cursor = p.nextCursor;
        } while (cursor);
      } catch (err) {
        this.log.warn(`${method} failed for ${upstream}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  async listTools(): Promise<Tool[]> {
    const all = await this.listAll("tools/list", "tools", async (c, cursor) => {
      const p = await c.listTools(cursor ? { cursor } : {});
      return { items: p.tools, nextCursor: p.nextCursor };
    });
    const routes = new Map<string, Route>();
    const tools = all.map(({ upstream, item: t }) => {
      const name = `${upstream}${TOOL_SEPARATOR}${t.name}`;
      routes.set(name, { upstream, tool: t.name, ...(t.annotations ? { annotations: t.annotations } : {}) });
      return { ...t, name };
    });
    this.routes = routes;
    return tools;
  }

  async listPrompts(): Promise<Prompt[]> {
    const all = await this.listAll("prompts/list", "prompts", async (c, cursor) => {
      const p = await c.listPrompts(cursor ? { cursor } : {});
      return { items: p.prompts, nextCursor: p.nextCursor };
    });
    const routes = new Map<string, PromptRoute>();
    const prompts = all.map(({ upstream, item: p }) => {
      const name = `${upstream}${TOOL_SEPARATOR}${p.name}`;
      routes.set(name, { upstream, prompt: p.name });
      return { ...p, name };
    });
    this.promptRoutes = routes;
    return prompts;
  }

  async listResources(): Promise<Resource[]> {
    const all = await this.listAll("resources/list", "resources", async (c, cursor) => {
      const p = await c.listResources(cursor ? { cursor } : {});
      return { items: p.resources, nextCursor: p.nextCursor };
    });
    const routes = new Map<string, Set<string>>();
    for (const { upstream, item } of all) {
      const ups = routes.get(item.uri) ?? new Set<string>();
      ups.add(upstream);
      routes.set(item.uri, ups);
    }
    for (const [uri, ups] of routes) {
      if (ups.size > 1) this.log.warn(`resource ${uri} is offered by ${[...ups].join(", ")}; reading it will be refused`);
    }
    this.resourceRoutes = routes;
    return all.map((a) => a.item);
  }

  async listResourceTemplates(): Promise<ResourceTemplate[]> {
    const all = await this.listAll("resources/templates/list", "resources", async (c, cursor) => {
      const p = await c.listResourceTemplates(cursor ? { cursor } : {});
      return { items: p.resourceTemplates, nextCursor: p.nextCursor };
    });
    const routes: TemplateRoute[] = [];
    for (const { upstream, item } of all) {
      try {
        routes.push({ upstream, template: new UriTemplate(item.uriTemplate) });
      } catch (err) {
        this.log.warn(`ignoring resource template ${item.uriTemplate} from ${upstream}: ${(err as Error).message}`);
      }
    }
    this.templateRoutes = routes;
    return all.map((a) => a.item);
  }

  /** The one upstream that serves `uri`: an exact listing wins, then template matches. */
  private async resourceUpstream(uri: string): Promise<string> {
    if (!this.resourceRoutes.has(uri)) await this.listResources();
    let candidates = [...(this.resourceRoutes.get(uri) ?? [])];
    if (candidates.length === 0) {
      if (this.templateRoutes.length === 0) await this.listResourceTemplates();
      candidates = [...new Set(this.templateRoutes.filter((t) => t.template.match(uri) !== null).map((t) => t.upstream))];
    }
    if (candidates.length === 0) throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
    if (candidates.length > 1) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Resource ${uri} could come from more than one server (${candidates.join(", ")}). ` +
          `ADTL can't tell which server to label it as, so it was not read.`,
      );
    }
    return candidates[0]!;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const upstream = await this.resourceUpstream(uri);
    const client = this.upstreams.get(upstream)!;
    return this.forwardLabeled("resources/read", upstream, { resource: uri }, { uri }, (params) =>
      client.readResource(params as { uri: string }),
    );
  }

  async getPrompt(name: string, args?: Record<string, string>): Promise<GetPromptResult> {
    let route = this.promptRoutes.get(name);
    if (!route) {
      await this.listPrompts();
      route = this.promptRoutes.get(name);
    }
    if (!route) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
    const client = this.upstreams.get(route.upstream)!;
    return this.forwardLabeled(
      "prompts/get",
      route.upstream,
      { prompt: route.prompt },
      { name: route.prompt, ...(args ? { arguments: args } : {}) },
      (params) => client.getPrompt(params as { name: string; arguments?: Record<string, string> }),
    );
  }

  /**
   * Forward a resources/read or prompts/get request through the interceptor
   * chain: request interceptors → upstream → response interceptors (adtl.label).
   * These requests have no tool result to carry an error, so a stopped request
   * becomes a JSON-RPC error.
   */
  private async forwardLabeled<R extends object>(
    event: "resources/read" | "prompts/get",
    upstream: string,
    target: { resource: string } | { prompt: string },
    params: Record<string, unknown>,
    send: (params: Record<string, unknown>) => Promise<R>,
  ): Promise<R> {
    const started = performance.now();
    const context: InvocationContext = {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      principal: this.principal,
    };
    const config = { server: upstream };
    const audit = this.invoker.modeOverride === "audit" ? { mode: "audit" as const } : {};
    let denied: Denial | undefined;
    const finish = (entry: Pick<AuditEntry, "outcome"> & Partial<AuditEntry>) =>
      this.audit?.write({
        ts: context.timestamp!,
        sessionId: this.sessionId,
        event,
        server: upstream,
        ...target,
        ...(denied ? { denied } : {}),
        ...entry,
        durationMs: Math.round(performance.now() - started),
      });
    const what = "resource" in target ? `resource ${target.resource}` : `prompt ${upstream}${TOOL_SEPARATOR}${target.prompt}`;

    denied = await this.authorize({
      event,
      server: upstream,
      ...target,
      ...(params.arguments ? { arguments: params.arguments as Record<string, unknown> } : {}),
    });
    if (denied && !("mode" in audit)) {
      finish({ outcome: "blocked", decision: "block", reason: denied.reason });
      this.log.info(`denied ${what}: ${denied.reason}`);
      throw new McpError(ErrorCode.InvalidRequest, `ADTL blocked this request: ${denied.reason}`);
    }
    if (denied) this.log.info(`audit: would deny ${what}: ${denied.reason}`);

    const req = await this.invoker.runRequest({ event, payload: { method: event, params }, config, context });
    if (req.blocked) {
      finish({ outcome: "blocked", decision: req.blocked.decision, reason: req.blocked.reason, warnings: req.warnings });
      this.log.info(`${req.blocked.decision} ${what}: ${req.blocked.reason}`);
      throw new McpError(ErrorCode.InvalidRequest, `ADTL blocked this request: ${req.blocked.reason}`);
    }
    const forwarded = (req.payload as { params: Record<string, unknown> }).params;

    let result: R;
    try {
      result = await send(forwarded);
    } catch (err) {
      finish({ outcome: "upstream_error", reason: (err as Error).message, ...audit, warnings: req.warnings });
      throw err;
    }

    const res = await this.invoker.runResponse({ event, payload: { method: event, params: forwarded, result }, config, context });
    const warnings = [...req.warnings, ...res.warnings];
    if (res.blocked) {
      // Fail closed: unlabeled content must not reach the agent.
      finish({ outcome: "blocked", decision: res.blocked.decision, reason: res.blocked.reason, warnings });
      this.log.warn(`${what} withheld: ${res.blocked.reason}`);
      throw new McpError(ErrorCode.InternalError, `ADTL could not label this content, so it was withheld: ${res.blocked.reason}`);
    }
    const label = infoOf(res, "adtl.label");
    finish({ outcome: "forwarded", ...audit, label: label.label, ...(label.ledger ? { ledger: label.ledger } : {}),
      ...(label.records ? { records: label.records } : {}), sessionLabel: label.sessionLabel, warnings });
    return (res.payload as { result: R }).result;
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
      principal: this.principal,
    };
    const config: Record<string, unknown> = {
      server: route.upstream,
      ...(route.annotations ? { toolAnnotations: route.annotations } : {}),
    };
    const base = { sessionId: this.sessionId, event: "tools/call" as const, server: route.upstream, tool: route.tool };
    let denied: Denial | undefined;
    const finish = (entry: Omit<AuditEntry, keyof typeof base | "ts" | "durationMs">) =>
      this.audit?.write({ ts: context.timestamp!, ...base, ...(denied ? { denied } : {}), ...entry, durationMs: Math.round(performance.now() - started) });

    // 0. Authorization: may this caller use this tool at all? A denial wins over any policy decision.
    denied = await this.authorize({ event: "tools/call", server: route.upstream, tool: route.tool, arguments: args });
    if (denied && this.invoker.modeOverride !== "audit") {
      finish({ outcome: "blocked", decision: "block", reason: denied.reason });
      this.log.info(`denied ${name}: ${denied.reason}`);
      this.approvals?.blocked({ sessionId: this.sessionId, server: route.upstream, tool: route.tool, reason: denied.reason, matched: [`authorizer:${denied.by}`] });
      return textError(`ADTL blocked this call: ${denied.reason}. You are not allowed to use this tool, so the call was not run.`, {
        decision: "block",
        reason: denied.reason,
        authorizer: denied.by,
      });
    }
    if (denied) this.log.info(`audit: would deny ${name}: ${denied.reason}`);

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
      ...(label.ledger ? { ledger: label.ledger } : {}),
      ...(label.records ? { records: label.records } : {}),
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
