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
import type { AdtlConfig } from "@adtl/labels";
import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";
import { JsonlAuditLog } from "./audit.js";
import {
  GatewayConfigSchema,
  expandUpstream,
  isHttpUpstream,
  type GatewayConfig,
  type StdioUpstream,
  type Upstream,
} from "./config.js";
import { AdtlGateway, GATEWAY_VERSION, type GatewayLogger } from "./gateway.js";
import { InterceptorInvoker } from "./invoker.js";

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

async function connect(id: string, u: Upstream, baseDir: string): Promise<Client> {
  const client = new Client({ name: `adtl-gateway→${id}`, version: GATEWAY_VERSION });
  const transport = isHttpUpstream(u)
    ? new StreamableHTTPClientTransport(new URL(u.url), { requestInit: { headers: u.headers } })
    : stdioTransport(u, baseDir);
  await client.connect(transport);
  return client;
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
    const icfg: StdioUpstream = loaded.gateway.interceptors
      ? expandUpstream("interceptors", loaded.gateway.interceptors, env)
      : { command: process.execPath, args: [bundledInterceptorsCli(), "--config", loaded.path], env: {} };
    const interceptors = await connect("interceptors", icfg, baseDir);
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
    const invoker = new InterceptorInvoker(bound, loaded.gateway.interceptorTimeoutMs);
    log.info(`interceptors: ${names.join(", ")}`);

    // 2. Upstream servers. One failing upstream does not stop the others.
    const upstreams = new Map<string, Client>();
    const ids = Object.keys(loaded.gateway.upstreams);
    const settled = await Promise.allSettled(
      ids.map((id) => connect(id, expandUpstream(id, loaded.gateway.upstreams[id]!, env), baseDir)),
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

    const audit = loaded.gateway.audit ? new JsonlAuditLog(resolve(baseDir, loaded.gateway.audit)) : undefined;
    const gateway = new AdtlGateway({ upstreams, invoker, ...(audit ? { audit } : {}), logger: log });
    return { gateway, close: closeAll };
  } catch (err) {
    await closeAll();
    throw err;
  }
}
