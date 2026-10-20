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
 * With a ledger, PostToolUse also re-labels output that contains content a
 * tainted session wrote earlier, and, when this session is tainted, records
 * what the tool was given (file contents, edits, prompts) and the lines a
 * shell command added to files.
 *
 * Errors fail closed: a PreToolUse hook that can't decide denies the call.
 */
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import {
  callHash,
  evaluatePolicy,
  labelResult,
  toolEgress,
  type AdtlConfig,
  type Decision,
  type PolicyDecision,
  type SessionStore,
  join,
} from "@adtl/labels";
import { chunkHashes, valueHashes, type Ledger } from "@adtl/ledger";
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
  /** Label ledger shared with the gateway. */
  ledger?: Ledger;
  /** Files the agent must not change: the ADTL config, the session directory and the ledger. */
  protect?: { configPath?: string; sessionsDir?: string; ledgerPath?: string; auditPath?: string };
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
    // Prefix match also covers SQLite's -wal and -shm files.
    if (protect.ledgerPath && abs.startsWith(resolve(protect.ledgerPath))) {
      return { decision: "block", reason: "The agent may not change the ADTL ledger" };
    }
    // Prefix match also covers the .lock file.
    if (protect.auditPath && abs.startsWith(resolve(protect.auditPath))) {
      return { decision: "block", reason: "The agent may not change the ADTL audit log" };
    }
  }
  const command = typeof args.command === "string" ? args.command : undefined;
  if (command !== undefined && ["Bash", "Monitor"].includes(route.tool)) {
    const marks = [".adtl/sessions", protect.sessionsDir].filter((m): m is string => !!m);
    if (marks.some((m) => command.includes(m))) {
      return { decision: "ask", reason: "This command touches ADTL session labels" };
    }
    const ledgerMarks = ["ledger.db", "ledger declassify", protect.ledgerPath].filter((m): m is string => !!m);
    if (ledgerMarks.some((m) => command.includes(m))) {
      return { decision: "ask", reason: "This command touches the ADTL ledger" };
    }
    if (protect.auditPath && command.includes(basename(protect.auditPath))) {
      return { decision: "ask", reason: "This command touches the ADTL audit log" };
    }
  }
  return undefined;
}

/** Text a shell command added to files, from Claude Code's `bashEditDiff` (one string per file). */
export function addedLines(output: unknown): string[] {
  const files = isRecord(output) && isRecord(output.bashEditDiff) && Array.isArray(output.bashEditDiff.files) ? output.bashEditDiff.files : [];
  const out: string[] = [];
  for (const f of files) {
    const hunks = isRecord(f) && Array.isArray(f.hunks) ? f.hunks : [];
    const lines = hunks.flatMap((h) => (isRecord(h) && Array.isArray(h.lines) ? h.lines : []));
    const added = lines.filter((l): l is string => typeof l === "string" && l.startsWith("+")).map((l) => l.slice(1));
    if (added.length) out.push(added.join("\n"));
  }
  return out;
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
    const output = input.tool_response ?? input.error ?? null;
    let label = labelResult({ ...route, result: output }, config);
    let ledger: { chunks: number; writers: string[] } | undefined;
    if (opts.ledger) {
      const match = opts.ledger.lookup(valueHashes(output));
      if (match) {
        label = join(label, match.label);
        ledger = { chunks: match.chunks, writers: match.writers };
      }
      // What the tool was given came from the session as it was before this output.
      const before = opts.sessions.get(input.session_id);
      const written = [...valueHashes(input.tool_input ?? {}), ...addedLines(output).flatMap(chunkHashes)];
      opts.ledger.record(written, before, input.session_id, route);
    }
    const sessionLabel = opts.sessions.observe(input.session_id, label);
    opts.audit?.write({ ...base, outcome: "forwarded", label, ...(ledger ? { ledger } : {}), sessionLabel, durationMs: 0 });
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
