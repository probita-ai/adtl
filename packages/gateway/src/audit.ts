/**
 * Append-only JSONL audit log. One line per tool call.
 *
 * Arguments and results are never written; the call is identified by its
 * hash, so the log can be shared without leaking the data it describes.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface AuditEntry {
  ts: string;
  sessionId: string;
  event: "tools/call";
  server: string;
  tool: string;
  /** Final outcome of the call. */
  outcome: "forwarded" | "blocked" | "upstream_error";
  /** The policy's decision. In audit mode a call can be forwarded with decision "ask" or "block". */
  decision?: string;
  /** Present when the gateway ran in audit mode: nothing was stopped or changed. */
  mode?: "audit";
  reason?: string;
  matched?: unknown;
  callHash?: unknown;
  label?: unknown;
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
