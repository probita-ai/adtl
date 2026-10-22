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
 *     principal: { id: "${USER}" }       # optional: who runs this gateway (default: anonymous)
 *     roles:                             # optional: who may use which tools (deny by default)
 *       maintainers: { members: [alice], tools: ["github.*"] }
 *       readers:     { members: ["*"],   tools: ["github.read_*", "github.get_*"] }
 *     approvals:                         # optional: make "ask" really ask
 *       timeoutSeconds: 50
 *       ntfy: { topic: "${ADTL_NTFY_TOPIC}" }
 *       approvers:                       # optional: each approver's own channel (policy rule `approvers:`)
 *         alice: { ntfy: { topic: "${ALICE_NTFY_TOPIC}" } }
 *       email:
 *         smtp: { host: smtp.example.com, port: 465, user: "${SMTP_USER}", pass: "${SMTP_PASS}" }
 *         from: adtl@example.com
 *         to: you@example.com
 *
 * `${VAR}` in command, args, env, cwd, url, headers, approval settings and principal.id is
 * replaced from the gateway's environment. A missing variable is a config error,
 * unless a default is given: `${VAR:-default}`.
 */
import { z } from "zod";
import { EMAIL_EVENTS } from "./email.js";

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

export const NtfyConfigSchema = z
  .object({
    server: z.string().min(1).default("https://ntfy.sh"),
    /** Topic approval requests are sent to. Anyone who can read it can approve: keep it secret. */
    topic: z.string().min(1),
    /** Topic answers are posted to. Default: `<topic>-reply`. */
    replyTopic: z.string().min(1).optional(),
    token: z.string().min(1).optional(),
  })
  .strict();

export const EmailConfigSchema = z
  .object({
    smtp: z
      .object({
        host: z.string().min(1),
        port: z.number().int().positive().default(587),
        /** TLS from the start. Default: true on port 465, otherwise STARTTLS. */
        secure: z.boolean().optional(),
        user: z.string().min(1).optional(),
        pass: z.string().optional(),
      })
      .strict(),
    from: z.string().min(1),
    to: z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]),
    on: z.array(z.enum(EMAIL_EVENTS)).nonempty().default(["pending", "blocked"]),
  })
  .strict();

export const ApprovalsConfigSchema = z
  .object({
    /**
     * How long a call waits for an answer; no answer means deny. Many MCP
     * clients give up on a request after 60 seconds, hence the default.
     */
    timeoutSeconds: z.number().int().positive().max(3600).default(50),
    ntfy: NtfyConfigSchema.optional(),
    email: EmailConfigSchema.optional(),
    /**
     * Each approver's own channel, by principal id. Policy rules with
     * `approvers: [role]` ask only these people, so the answer names who approved.
     */
    approvers: z.record(z.object({ ntfy: NtfyConfigSchema }).strict()).optional(),
  })
  .strict();
export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>;

/** `server.tool` (or `server.prompt`), with `*` wildcards, as in policy rules. */
const QualifiedPattern = z
  .string()
  .min(1)
  .refine((p) => /^[^.]+\..+$/.test(p), { message: 'Use "server.name" with optional * wildcards, e.g. "github.read_*" or "github.*"' });

export const PrincipalConfigSchema = z
  .object({
    type: z.enum(["user", "service"]).default("user"),
    id: z.string().min(1),
    claims: z.record(z.unknown()).optional(),
  })
  .strict();
export type PrincipalConfig = z.infer<typeof PrincipalConfigSchema>;

export const RoleSchema = z
  .object({
    /** Principal ids; "*" means everyone, including an anonymous caller. */
    members: z.array(z.string().min(1)).nonempty("A role needs at least one member (\"*\" for everyone)"),
    tools: z.array(QualifiedPattern).default([]),
    prompts: z.array(QualifiedPattern).default([]),
    /** Resource URI patterns, e.g. "github://acme/*". */
    resources: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((r) => r.tools.length + r.prompts.length + r.resources.length > 0, {
    message: "A role must grant at least one of tools, prompts or resources",
  });
export type RoleConfig = z.infer<typeof RoleSchema>;

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
    /** Human approvals for "ask" decisions. Without an answering channel, "ask" blocks. */
    approvals: ApprovalsConfigSchema.optional(),
    /** Timeout for each interceptor invocation, in milliseconds. */
    interceptorTimeoutMs: z.number().int().positive().default(5000),
    /** Who runs this gateway. Passed to the authorizer and the interceptors. Default: anonymous. */
    principal: PrincipalConfigSchema.optional(),
    /** Role-based authorization: when present, a call no role grants is denied. */
    roles: z
      .record(RoleSchema)
      .refine((r) => Object.keys(r).length > 0, "roles: needs at least one role (remove it to allow everyone)")
      .optional(),
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

/**
 * Replace `${VAR}` with values from `env`, and `${VAR:-default}` with `default`
 * when VAR is unset or empty (as Claude Code's .mcp.json does). `$${VAR}` keeps
 * a literal `${VAR}`.
 */
export function expandEnv(value: string, env: NodeJS.ProcessEnv, where: string): string {
  return value.replace(/(\$?)\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (match, escape: string, name: string, fallback?: string) => {
    if (escape) return match.slice(1);
    const v = env[name];
    if (fallback !== undefined) return v === undefined || v === "" ? fallback : v;
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

/** Expand `${VAR}` in every string of the approvals section. */
export function expandApprovals(a: ApprovalsConfig, env: NodeJS.ProcessEnv): ApprovalsConfig {
  const walk = (v: unknown, where: string): unknown => {
    if (typeof v === "string") return expandEnv(v, env, where);
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${where}[${i}]`));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, `${where}.${k}`)]));
    return v;
  };
  return walk(a, "gateway.approvals") as ApprovalsConfig;
}

export function isHttpUpstream(u: Upstream): u is HttpUpstream {
  return "url" in u;
}
