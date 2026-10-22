/**
 * Build a running gateway from an adtl.yaml file: start the interceptor
 * server, connect every upstream, and check that ADTL's interceptors are there.
 */
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { INTERCEPTORS_EXTENSION, LABEL_INTERCEPTOR, POLICY_INTERCEPTOR, parseConfigText } from "@adtl/interceptors";
import { defaultSessionsDir, type AdtlConfig } from "@adtl/labels";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { ApprovalBroker, type Notifier } from "./approvals.js";
import { JsonlAuditLog } from "./audit.js";
import type { Principal } from "./authorizer.js";
import {
  GatewayConfigSchema,
  expandApprovals,
  expandEnv,
  expandUpstream,
  isHttpUpstream,
  type GatewayConfig,
  type StdioUpstream,
  type Upstream,
} from "./config.js";
import { EmailNotifier } from "./email.js";
import { AdtlGateway, GATEWAY_VERSION, type GatewayLogger } from "./gateway.js";
import { InterceptorInvoker } from "./invoker.js";
import { NtfyNotifier } from "./ntfy.js";
import { RoleAuthorizer } from "./roles.js";

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayConfigError";
  }
}

export interface LoadedConfig {
  path: string;
  labels: AdtlConfig;
  gateway: GatewayConfig;
}

export async function loadGatewayConfig(path: string): Promise<LoadedConfig> {
  const abs = resolve(path);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    throw new GatewayConfigError(`Cannot read config file ${abs}: ${(err as Error).message}`);
  }
  return parseGatewayConfigText(text, abs);
}

/** Validate adtl.yaml text; `path` is where it lives (relative paths in it resolve against its directory). */
export function parseGatewayConfigText(text: string, path: string): LoadedConfig {
  const abs = resolve(path);
  let labels: AdtlConfig;
  try {
    labels = parseConfigText(text, abs);
  } catch (err) {
    throw new GatewayConfigError((err as Error).message);
  }
  const raw = (parseYaml(text) ?? {}) as { gateway?: unknown };
  if (raw.gateway === undefined) {
    throw new GatewayConfigError(`${abs}: missing "gateway:" section (at least one upstream under gateway.upstreams)`);
  }
  try {
    return { path: abs, labels, gateway: GatewayConfigSchema.parse(raw.gateway) };
  } catch (err) {
    if (err instanceof ZodError) {
      const problems = err.issues.map((i) => `  - gateway.${i.path.join(".")}: ${i.message}`).join("\n");
      throw new GatewayConfigError(`${abs}: invalid gateway config\n${problems}`);
    }
    throw err;
  }
}

/** Path of the bundled adtl-interceptors CLI. */
export function bundledInterceptorsCli(): string {
  // Resolve via package.json: works in plain Node and under tools that lack import.meta.resolve.
  const pkg = createRequire(import.meta.url).resolve("@adtl/interceptors/package.json");
  return resolve(dirname(pkg), "dist", "cli.js");
}

function stdioTransport(u: StdioUpstream, baseDir: string): StdioClientTransport {
  return new StdioClientTransport({
    command: u.command,
    args: u.args,
    // The SDK passes only `env` when given, which would drop PATH; start from its safe defaults.
    env: { ...getDefaultEnvironment(), ...u.env },
    ...(u.cwd !== undefined ? { cwd: isAbsolute(u.cwd) ? u.cwd : resolve(baseDir, u.cwd) } : {}),
    stderr: "inherit",
  });
}

export async function connectUpstream(id: string, u: Upstream, baseDir: string): Promise<Client> {
  const client = new Client({ name: `adtl-gateway→${id}`, version: GATEWAY_VERSION });
  const transport = isHttpUpstream(u)
    ? new StreamableHTTPClientTransport(new URL(u.url), { requestInit: { headers: u.headers } })
    : stdioTransport(u, baseDir);
  await client.connect(transport);
  return client;
}

/** Build the approval broker from `gateway.approvals`, or undefined if not configured. */
export function createApprovals(cfg: GatewayConfig, env: NodeJS.ProcessEnv, log: GatewayLogger): ApprovalBroker | undefined {
  if (!cfg.approvals) return undefined;
  const a = expandApprovals(cfg.approvals, env);
  const notifiers: Notifier[] = [];
  if (a.ntfy) {
    if (/^https:\/\/ntfy\.sh\/?$/.test(a.ntfy.server) && a.ntfy.topic.length < 20 && !a.ntfy.token) {
      log.warn("gateway.approvals.ntfy.topic is short and on the public ntfy.sh server: anyone who guesses it can approve calls. Use a long random topic.");
    }
    notifiers.push(new NtfyNotifier(a.ntfy));
  }
  if (a.email) {
    notifiers.push(new EmailNotifier({ smtp: a.email.smtp, from: a.email.from, to: [a.email.to].flat(), on: a.email.on }));
  }
  const approverChannels = new Map<string, Notifier[]>(
    Object.entries(a.approvers ?? {}).map(([id, c]) => [id, [new NtfyNotifier({ ...c.ntfy, name: `ntfy:${id}` })]]),
  );
  if (notifiers.length === 0 && approverChannels.size === 0) return undefined;
  if (!notifiers.some((n) => n.listen) && approverChannels.size === 0) {
    log.warn('no approval channel can carry answers (configure gateway.approvals.ntfy); "ask" still blocks');
  }
  const approvers = approverChannels.size ? `; approvers: ${[...approverChannels.keys()].join(", ")}` : "";
  log.info(`approvals: ${notifiers.map((n) => n.name).join(", ") || "none shared"}${approvers} (timeout ${a.timeoutSeconds}s)`);
  return new ApprovalBroker({ notifiers, approverChannels, timeoutMs: a.timeoutSeconds * 1000, log });
}

/**
 * Check that every role a policy rule names under `approvers:` exists, has
 * named members, and that each member has a channel in
 * `gateway.approvals.approvers`. Returns each such role's members.
 */
export function approverRoles(labels: AdtlConfig, cfg: GatewayConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const problems: string[] = [];
  for (const rule of labels.policy.rules) {
    for (const role of rule.approvers ?? []) {
      if (out.has(role)) continue;
      const r = cfg.roles?.[role];
      if (!r) {
        problems.push(`policy rule "${rule.name}" names approver role "${role}", which is not under gateway.roles`);
        continue;
      }
      const members = [...r.members];
      if (members.includes("*")) problems.push(`approver role "${role}" has member "*": approvers must be named, so the answer says who approved`);
      for (const m of members.filter((x) => x !== "*")) {
        if (!cfg.approvals?.approvers?.[m]) problems.push(`approver "${m}" (role "${role}") has no channel under gateway.approvals.approvers`);
      }
      out.set(role, members);
    }
  }
  if (problems.length) throw new GatewayConfigError(`approvers:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  return out;
}

/** `gateway.principal`, with `${VAR}` in its id expanded. */
export function gatewayPrincipal(cfg: GatewayConfig, env: NodeJS.ProcessEnv): Principal | undefined {
  const p = cfg.principal;
  if (!p) return undefined;
  const id = expandEnv(p.id, env, "gateway.principal.id").trim();
  if (!id) throw new GatewayConfigError("gateway.principal.id is empty after expanding environment variables");
  return { type: p.type, id, ...(p.claims ? { claims: p.claims } : {}) };
}

/**
 * Under Claude Code, which passes `CLAUDE_CODE_SESSION_ID` to stdio MCP
 * servers, the gateway uses that id and keeps session labels in files, so the
 * Claude Code hooks (`adtl-gateway hook`) add to the same session label.
 */
export function sharedSession(env: NodeJS.ProcessEnv): { sessionId: string; dir: string } | undefined {
  const sessionId = env.CLAUDE_CODE_SESSION_ID?.trim();
  return sessionId ? { sessionId, dir: defaultSessionsDir(env) } : undefined;
}

export interface StartedGateway {
  gateway: AdtlGateway;
  close(): Promise<void>;
}

export async function startGateway(
  loaded: LoadedConfig,
  opts: { env?: NodeJS.ProcessEnv; logger?: GatewayLogger } = {},
): Promise<StartedGateway> {
  const env = opts.env ?? process.env;
  // Config problems that need no process: fail before starting any.
  const approverMembers = approverRoles(loaded.labels, loaded.gateway);
  const baseDir = dirname(loaded.path);
  const log = opts.logger ?? { info: (m: string) => console.error(`[adtl-gateway] ${m}`), warn: (m: string) => console.error(`[adtl-gateway] warning: ${m}`) };
  const clients: Client[] = [];
  const closeAll = () => Promise.allSettled(clients.map((c) => c.close())).then(() => undefined);

  try {
    // 1. Interceptor server (out of process, per the Interceptors WG).
    const shared = sharedSession(env);
    const custom = loaded.gateway.interceptors && expandUpstream("interceptors", loaded.gateway.interceptors, env);
    // The interceptor process starts with a minimal environment; pass on where the ledger lives.
    const ledgerEnv: Record<string, string> = env.ADTL_LEDGER ? { ADTL_LEDGER: env.ADTL_LEDGER } : {};
    const icfg: StdioUpstream = custom
      ? { ...custom, env: { ...ledgerEnv, ...custom.env, ...(shared ? { ADTL_SESSIONS_DIR: shared.dir } : {}) } }
      : {
          command: process.execPath,
          args: [bundledInterceptorsCli(), "--config", loaded.path, ...(shared ? ["--sessions-dir", shared.dir] : [])],
          env: ledgerEnv,
        };
    const interceptors = await connectUpstream("interceptors", icfg, baseDir);
    clients.push(interceptors);
    if (!interceptors.getServerCapabilities()?.extensions?.[INTERCEPTORS_EXTENSION]) {
      throw new GatewayConfigError(`The interceptor server does not declare the ${INTERCEPTORS_EXTENSION} extension`);
    }
    const bound = await InterceptorInvoker.discover(interceptors);
    const names = bound.map((b) => b.definition.name);
    for (const required of [POLICY_INTERCEPTOR, LABEL_INTERCEPTOR]) {
      if (!names.includes(required)) {
        throw new GatewayConfigError(`The interceptor server does not offer ${required}; refusing to start without it`);
      }
    }
    const audit = loaded.gateway.mode === "audit";
    const invoker = new InterceptorInvoker(bound, loaded.gateway.interceptorTimeoutMs, audit ? "audit" : undefined);
    log.info(`interceptors: ${names.join(", ")}`);
    if (shared) log.info(`sharing session labels with Claude Code hooks (${shared.dir})`);
    if (audit) log.warn("audit mode: calls are logged but never stopped or changed");

    // 2. Upstream servers. One failing upstream does not stop the others.
    const upstreams = new Map<string, Client>();
    const ids = Object.keys(loaded.gateway.upstreams);
    const settled = await Promise.allSettled(
      ids.map((id) => connectUpstream(id, expandUpstream(id, loaded.gateway.upstreams[id]!, env), baseDir)),
    );
    settled.forEach((s, i) => {
      const id = ids[i]!;
      if (s.status === "fulfilled") {
        clients.push(s.value);
        upstreams.set(id, s.value);
        if (!loaded.labels.servers[id]) {
          log.warn(`upstream "${id}" has no entry under servers: in the label config; its results get the default label`);
        }
      } else {
        log.warn(`could not connect to upstream "${id}": ${(s.reason as Error).message}`);
      }
    });
    if (upstreams.size === 0) throw new GatewayConfigError("No upstream server could be connected");
    log.info(`upstreams: ${[...upstreams.keys()].join(", ")}`);

    const auditLog = loaded.gateway.audit ? new JsonlAuditLog(resolve(baseDir, loaded.gateway.audit)) : undefined;
    const approvals = createApprovals(loaded.gateway, env, log);
    const principal = gatewayPrincipal(loaded.gateway, env);
    const roles = loaded.gateway.roles;
    if (roles) {
      log.info(`roles: ${Object.keys(roles).join(", ")} (caller: ${principal?.id ?? "anonymous"})`);
      if (!principal) log.warn('roles are set but gateway.principal is not: only roles with members ["*"] apply');
    }
    const gateway = new AdtlGateway({
      ...(shared ? { sessionId: shared.sessionId } : {}),
      upstreams,
      invoker,
      ...(auditLog ? { audit: auditLog } : {}),
      ...(approvals ? { approvals } : {}),
      ...(roles ? { authorizer: new RoleAuthorizer(roles) } : {}),
      ...(principal ? { principal } : {}),
      ...(approverMembers.size ? { approverRoles: approverMembers } : {}),
      logger: log,
    });
    return { gateway, close: closeAll };
  } catch (err) {
    await closeAll();
    throw err;
  }
}
