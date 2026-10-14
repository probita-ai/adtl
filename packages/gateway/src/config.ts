/**
 * The `gateway:` section of adtl.yaml.
 *
 *   gateway:
 *     audit: ./adtl-audit.jsonl          # optional JSONL audit log
 *     mode: audit                        # optional: log what would be stopped, stop nothing
 *     upstreams:
 *       github:                          # id must match `servers.github` in the label config
 *         command: npx
 *         args: ["-y", "@modelcontextprotocol/server-github"]
 *         env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
 *       docs:
 *         url: https://example.com/mcp
 *         headers: { Authorization: "Bearer ${DOCS_TOKEN}" }
 *
 * `${VAR}` in command, args, env, cwd, url and headers is replaced from the
 * gateway's environment. A missing variable is a config error.
 */
import { z } from "zod";

const UPSTREAM_ID = /^[A-Za-z0-9-]+$/;

export const StdioUpstreamSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    cwd: z.string().optional(),
  })
  .strict();

export const HttpUpstreamSchema = z
  .object({
    url: z.string().min(1),
    headers: z.record(z.string()).default({}),
  })
  .strict();

export const UpstreamSchema = z.union([StdioUpstreamSchema, HttpUpstreamSchema]);
export type StdioUpstream = z.infer<typeof StdioUpstreamSchema>;
export type HttpUpstream = z.infer<typeof HttpUpstreamSchema>;
export type Upstream = z.infer<typeof UpstreamSchema>;

export const GatewayConfigSchema = z
  .object({
    upstreams: z
      .record(UpstreamSchema)
      .refine((u) => Object.keys(u).length > 0, "At least one upstream server is required")
      .refine((u) => Object.keys(u).every((id) => UPSTREAM_ID.test(id)), {
        message: "Upstream ids may only contain letters, digits and '-' (they prefix tool names as <id>__<tool>)",
      }),
    /** How to start the interceptor server. Default: the bundled adtl-interceptors with this same config file. */
    interceptors: StdioUpstreamSchema.optional(),
    /** Path of a JSONL audit log. Relative paths are resolved against the config file's directory. */
    audit: z.string().min(1).optional(),
    /**
     * `active` (default) enforces the policy. `audit` stops and changes nothing, and
     * logs what would have been stopped: for trying a policy out safely.
     */
    mode: z.enum(["active", "audit"]).default("active"),
    /** Timeout for each interceptor invocation, in milliseconds. */
    interceptorTimeoutMs: z.number().int().positive().default(5000),
  })
  .strict();
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export const TOOL_SEPARATOR = "__";

export class EnvExpansionError extends Error {
  constructor(readonly variable: string, where: string) {
    super(`Environment variable ${variable} is not set (used in ${where})`);
    this.name = "EnvExpansionError";
  }
}

/** Replace `${VAR}` with values from `env`. `$${VAR}` keeps a literal `${VAR}`. */
export function expandEnv(value: string, env: NodeJS.ProcessEnv, where: string): string {
  return value.replace(/(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, escape: string, name: string) => {
    if (escape) return match.slice(1);
    const v = env[name];
    if (v === undefined) throw new EnvExpansionError(name, where);
    return v;
  });
}

function expandRecord(rec: Record<string, string>, env: NodeJS.ProcessEnv, where: string): Record<string, string> {
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, expandEnv(v, env, `${where}.${k}`)]));
}

export function expandUpstream<T extends Upstream>(id: string, u: T, env: NodeJS.ProcessEnv): T {
  const where = `gateway.upstreams.${id}`;
  if ("url" in u) {
    return { ...u, url: expandEnv(u.url, env, `${where}.url`), headers: expandRecord(u.headers, env, `${where}.headers`) };
  }
  return {
    ...u,
    command: expandEnv(u.command, env, `${where}.command`),
    args: u.args.map((a, i) => expandEnv(a, env, `${where}.args[${i}]`)),
    env: expandRecord(u.env, env, `${where}.env`),
    ...(u.cwd !== undefined ? { cwd: expandEnv(u.cwd, env, `${where}.cwd`) } : {}),
  };
}

export function isHttpUpstream(u: Upstream): u is HttpUpstream {
  return "url" in u;
}
