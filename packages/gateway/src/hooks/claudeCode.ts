/**
 * Claude Code hooks adapter: puts Claude Code's built-in tools (WebFetch, Read,
 * Bash, …) and MCP servers that don't go through the gateway under the same
 * labels and policy as gateway calls.
 *
 *   PreToolUse          runs the policy against the session label:
 *                       block → deny, ask → Claude Code's permission prompt,
 *                       allow → no answer, so Claude Code's own permissions apply
 *   PostToolUse         labels the tool's output and adds it to the session label
 *   PostToolUseFailure  same: a failed tool's error output still reaches the model
 *
 * Built-in tools are labeled as the server `claude-code` (see preset.ts); MCP
 * tools `mcp__<server>__<tool>` as `<server>`. Tools of the gateway's own MCP
 * server (`mcp__adtl__*` by default) are skipped: the gateway checks those.
 *
 * Hooks and gateway share one session label through a FileSessionStore keyed
 * by Claude Code's session id, which the gateway reads from
 * `CLAUDE_CODE_SESSION_ID`.
 *
 * Errors fail closed: a PreToolUse hook that can't decide denies the call.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  callHash,
  evaluatePolicy,
  labelResult,
  toolEgress,
  type AdtlConfig,
  type Decision,
  type PolicyDecision,
  type SessionStore,
} from "@adtl/labels";
import type { AuditEntry, AuditSink } from "../audit.js";
import { CLAUDE_CODE_PRESET, CLAUDE_CODE_SERVER } from "./preset.js";

export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  /** PostToolUseFailure: the error the tool returned. */
  error?: unknown;
  cwd?: string;
}

export interface HookOptions {
  config: AdtlConfig;
  sessions: SessionStore;
  /** Name of the gateway in Claude Code's MCP config; its tools are skipped. Default `adtl`. */
  gatewayServer?: string;
  /** `audit`: decide and log, but never deny or ask. */
  mode?: "active" | "audit";
  audit?: AuditSink;
  /** Files the agent must not change: the ADTL config and the session directory. */
  protect?: { configPath?: string; sessionsDir?: string };
}

/** What the hook process prints and exits with. */
export interface HookOutcome {
  stdout?: Record<string, unknown>;
  stderr?: string;
  exitCode: number;
}

const NOTHING: HookOutcome = { exitCode: 0 };

/** `config` with labels for Claude Code's built-in tools; rules under `servers.claude-code` win. */
export function withClaudeCodePreset(config: AdtlConfig): AdtlConfig {
  const own = config.servers[CLAUDE_CODE_SERVER];
  return {
    ...config,
    servers: {
      ...config.servers,
      [CLAUDE_CODE_SERVER]: {
        acceptServerClaims: own?.acceptServerClaims ?? false,
        ...(own?.defaults ? { defaults: own.defaults } : {}),
        tools: { ...CLAUDE_CODE_PRESET, ...own?.tools },
      },
    },
  };
}

/** Which ADTL server and tool a Claude Code tool name is, or undefined for the gateway's own tools. */
export function routeTool(toolName: string, gatewayServer = "adtl"): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (!m) return { server: CLAUDE_CODE_SERVER, tool: toolName };
  if (m[1] === gatewayServer) return undefined;
  return { server: m[1]!, tool: m[2]! };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inside(path: string, dir: string): boolean {
  const r = relative(dir, path);
  return r === "" || (!r.startsWith(`..${sep}`) && r !== ".." && !isAbsolute(r));
}

/**
 * A best-effort guard against the agent clearing its own taint by editing the
 * config or deleting session files. Not a sandbox: Bash can always find a way.
 */
function protectedTarget(input: HookInput, route: { server: string; tool: string }, protect: HookOptions["protect"]): { decision: Decision; reason: string } | undefined {
  if (!protect || route.server !== CLAUDE_CODE_SERVER) return undefined;
  const args = isRecord(input.tool_input) ? input.tool_input : {};
  const cwd = input.cwd ?? process.cwd();
  const path = typeof args.file_path === "string" ? args.file_path : typeof args.notebook_path === "string" ? args.notebook_path : undefined;
  if (path !== undefined && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(route.tool)) {
    const abs = resolve(cwd, path);
    if (protect.configPath && abs === resolve(protect.configPath)) {
      return { decision: "block", reason: "The agent may not change the ADTL config; edit it yourself" };
    }
    if (protect.sessionsDir && inside(abs, resolve(protect.sessionsDir))) {
      return { decision: "block", reason: "The agent may not change ADTL session labels" };
    }
  }
  const command = typeof args.command === "string" ? args.command : undefined;
  if (command !== undefined && ["Bash", "Monitor"].includes(route.tool)) {
    const marks = [".adtl/sessions", protect.sessionsDir].filter((m): m is string => !!m);
    if (marks.some((m) => command.includes(m))) {
      return { decision: "ask", reason: "This command touches ADTL session labels" };
    }
  }
  return undefined;
}

export function handleHook(input: HookInput, opts: HookOptions): HookOutcome {
  const event = input.hook_event_name;
  if (event !== "PreToolUse" && event !== "PostToolUse" && event !== "PostToolUseFailure") return NOTHING;
  if (typeof input.tool_name !== "string" || typeof input.session_id !== "string" || input.session_id === "") {
    return failure(event, "hook input has no tool_name or session_id");
  }
  const route = routeTool(input.tool_name, opts.gatewayServer);
  if (!route) return NOTHING;
  const config = withClaudeCodePreset(opts.config);
  const ts = new Date().toISOString();
  const base = { ts, sessionId: input.session_id, event: "tools/call" as const, ...route, via: "claude-code-hook" as const };

  if (event !== "PreToolUse") {
    const label = labelResult({ ...route, result: input.tool_response ?? input.error ?? null }, config);
    const sessionLabel = opts.sessions.observe(input.session_id, label);
    opts.audit?.write({ ...base, outcome: "forwarded", label, sessionLabel, durationMs: 0 });
    return NOTHING;
  }

  const hash = callHash(route.server, route.tool, input.tool_input ?? {});
  const session = opts.sessions.get(input.session_id);
  const guard = protectedTarget(input, route, opts.protect);
  const policy: PolicyDecision = evaluatePolicy(config.policy, {
    session,
    ...route,
    egress: toolEgress(config, route.server, route.tool),
  });
  const d: PolicyDecision =
    guard && (guard.decision === "block" || policy.decision === "allow")
      ? { decision: guard.decision, reason: guard.reason, matched: ["adtl-self-protection"] }
      : policy;
  if (d.decision === "allow") return NOTHING;

  const audit = opts.mode === "audit";
  const entry: AuditEntry = {
    ...base,
    outcome: audit ? "forwarded" : d.decision === "ask" ? "asked" : "blocked",
    decision: d.decision,
    ...(audit ? { mode: "audit" as const } : {}),
    reason: d.reason,
    matched: d.matched,
    callHash: hash,
    sessionLabel: session,
    durationMs: 0,
  };
  opts.audit?.write(entry);
  if (audit) return NOTHING;

  return {
    exitCode: 0,
    stdout: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: d.decision === "ask" ? "ask" : "deny",
        permissionDecisionReason:
          d.decision === "ask" ? `ADTL: ${d.reason}. Approve only if you expected this call.` : `ADTL blocked this call: ${d.reason}.`,
      },
    },
  };
}

/** Fail closed: exit 2 stops a PreToolUse call and shows the reason to Claude. */
export function failure(event: string | undefined, why: string): HookOutcome {
  const stopped = event === "PreToolUse" ? " The call was stopped." : "";
  return { exitCode: 2, stderr: `ADTL hook error: ${why}.${stopped}` };
}
