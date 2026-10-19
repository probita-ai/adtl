/**
 * Append-only JSONL audit log. One line per tool call, resource read or prompt get.
 *
 * Arguments and results are never written; the call is identified by its
 * hash, so the log can be shared without leaking the data it describes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  sessionId: string;
  event: "tools/call" | "resources/read" | "prompts/get";
  server: string;
  /** Exactly one of tool, resource or prompt is set, matching `event`. */
  tool?: string;
  resource?: string;
  prompt?: string;
  /** Final outcome of the call. "asked": handed to Claude Code's permission prompt by the hook. */
  outcome: "forwarded" | "blocked" | "asked" | "upstream_error";
  /** Present when the entry was written by the Claude Code hook rather than the gateway. */
  via?: "claude-code-hook";
  /** The policy's decision. In audit mode a call can be forwarded with decision "ask" or "block". */
  decision?: string;
  /** Present when the gateway ran in audit mode: nothing was stopped or changed. */
  mode?: "audit";
  /** Present when a human was asked: outcome, channel, approver (if known) and wait time. */
  approval?: { outcome: string; channel?: string; approver?: string; waitedMs: number };
  reason?: string;
  matched?: unknown;
  callHash?: unknown;
  label?: unknown;
  /** Present when the label ledger recognized content in the result: how many chunks matched, and which sessions wrote them. */
  ledger?: unknown;
  /** Present when the result carried record label stamps: how many, and which sessions wrote them. */
  records?: unknown;
  sessionLabel?: unknown;
  warnings?: string[];
  durationMs: number;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

export class JsonlAuditLog implements AuditSink {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }
}

export class MemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
