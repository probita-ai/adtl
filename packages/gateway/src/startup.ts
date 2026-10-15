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
import {
  GatewayConfigSchema,
  expandApprovals,
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
  if (notifiers.length === 0) return undefined;
  if (!notifiers.some((n) => n.listen)) log.warn('no approval channel can carry answers (configure gateway.approvals.ntfy); "ask" still blocks');
  log.info(`approvals: ${notifiers.map((n) => n.name).join(", ")} (timeout ${a.timeoutSeconds}s)`);
  return new ApprovalBroker({ notifiers, timeoutMs: a.timeoutSeconds * 1000, log });
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
  const baseDir = dirname(loaded.path);
  const log = opts.logger ?? { info: (m: string) => console.error(`[adtl-gateway] ${m}`), warn: (m: string) => console.error(`[adtl-gateway] warning: ${m}`) };
  const clients: Client[] = [];
  const closeAll = () => Promise.allSettled(clients.map((c) => c.close())).then(() => undefined);

  try {
    // 1. Interceptor server (out of process, per the Interceptors WG).
    const shared = sharedSession(env);
    const custom = loaded.gateway.interceptors && expandUpstream("interceptors", loaded.gateway.interceptors, env);
    const icfg: StdioUpstream = custom
      ? { ...custom, env: { ...custom.env, ...(shared ? { ADTL_SESSIONS_DIR: shared.dir } : {}) } }
      : {
          command: process.execPath,
          args: [bundledInterceptorsCli(), "--config", loaded.path, ...(shared ? ["--sessions-dir", shared.dir] : [])],
          env: {},
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
    const gateway = new AdtlGateway({
      ...(shared ? { sessionId: shared.sessionId } : {}),
      upstreams,
      invoker,
      ...(auditLog ? { audit: auditLog } : {}),
      ...(approvals ? { approvals } : {}),
      logger: log,
    });
    return { gateway, close: closeAll };
  } catch (err) {
    await closeAll();
    throw err;
  }
}
