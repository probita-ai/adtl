/**
 * Labels for Claude Code's built-in tools, used when `servers.claude-code`
 * doesn't override them. Built-in tools are labeled as the server `claude-code`.
 *
 * - Local reads (Read, Grep, Glob) are trusted but private: your own files.
 *   Files written from untrusted content aren't tracked until the v0.4 ledger.
 * - Web tools bring in untrusted content, and their URL or query can carry
 *   data out, so their egress is external.
 * - Bash can do anything: its output has unknown integrity, and its egress is
 *   unknown.
 * - Edits and bookkeeping tools return nothing worth labeling.
 */
import type { ToolRule } from "@adtl/labels";

export const CLAUDE_CODE_SERVER = "claude-code";

const localRead: ToolRule = { integrity: "trusted", confidentiality: "private", egress: "none" };
const localWrite: ToolRule = { integrity: "trusted", confidentiality: "public", egress: "none" };
const web: ToolRule = { integrity: "untrusted", confidentiality: "public", egress: "external" };
const shell: ToolRule = { integrity: "unknown", confidentiality: "private", egress: "unknown" };

export const CLAUDE_CODE_PRESET: Record<string, ToolRule> = {
  Read: localRead,
  Grep: localRead,
  Glob: localRead,
  LS: localRead,
  NotebookRead: localRead,
  Write: localWrite,
  Edit: localWrite,
  MultiEdit: localWrite,
  NotebookEdit: localWrite,
  TodoWrite: localWrite,
  AskUserQuestion: localWrite,
  Skill: localWrite,
  ToolSearch: localWrite,
  EnterPlanMode: localWrite,
  ExitPlanMode: localWrite,
  WebFetch: web,
  WebSearch: web,
  Bash: shell,
  BashOutput: shell,
  KillShell: localWrite,
  Monitor: shell,
  // A sub-agent's own tool calls go through these hooks too; its answer mixes what it saw.
  Agent: { integrity: "unknown", confidentiality: "private", egress: "none" },
  Task: { integrity: "unknown", confidentiality: "private", egress: "none" },
};
