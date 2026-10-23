/**
 * Append-only JSONL audit log. One line per tool call, resource read or prompt get.
 *
 * Arguments and results are never written; the call is identified by its
 * hash, so the log can be shared without leaking the data it describes.
 *
 * Lines are hash-chained: each carries `prev` (the hash of the line before)
 * and `hash` (over the canonical form of the line without `hash`), so
 * `adtl-gateway audit verify` detects lines that were edited, removed,
 * reordered or inserted. The gateway and the Claude Code hook (a new process
 * per tool call) write the same file, so appends take a lock file
 * (`<log>.lock`) to keep the chain from forking.
 *
 * The chain has no secret: an agent with shell access could rewrite the whole
 * file consistently, and cutting lines off the end is not detected. Signed
 * session receipts are planned for that.
 */
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { digest, sha256Hex } from "@adtl/labels";
import type { InterceptorRun } from "./invoker.js";

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
  /** Present when a Claude Code subagent made the call: its id and type (e.g. "Explore"). */
  agent?: { id: string; type?: string };
  /** The policy's decision. In audit mode a call can be forwarded with decision "ask" or "block". */
  decision?: string;
  /** Present when the gateway ran in audit mode: nothing was stopped or changed. */
  mode?: "audit";
  /** Present when the authorizer denied the caller: which one, and why. In audit mode the call still ran. */
  denied?: { by: string; reason: string };
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
  /** Every interceptor invocation for this call, with its resolved mode and failOpen and where each came from (SEP-2624). */
  interceptors?: InterceptorRun[];
  warnings?: string[];
  durationMs: number;
}

export interface AuditSink {
  write(entry: AuditEntry): void;
}

/** `prev` of the first line of a log. */
export const AUDIT_GENESIS = `sha256:${"0".repeat(64)}`;

const LOCK_TIMEOUT_MS = 5000;
/** A lock older than this was left by a process that died while holding it. */
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(lockPath: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      closeSync(openSync(lockPath, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
      } catch {
        // Released meanwhile; try again.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the audit log lock ${lockPath}`);
      sleepSync(5);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/** Last line of the file (without its newline), and whether the file ends with one. */
function tail(fd: number): { line?: string; endsWithNewline: boolean } {
  const size = fstatSync(fd).size;
  if (size === 0) return { endsWithNewline: true };
  const chunks: Buffer[] = [];
  let pos = size;
  let text = "";
  while (pos > 0) {
    const n = Math.min(65536, pos);
    pos -= n;
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, pos);
    chunks.unshift(buf);
    text = Buffer.concat(chunks).toString("utf8");
    if (text.slice(0, -1).includes("\n")) break;
  }
  const endsWithNewline = text.endsWith("\n");
  const body = endsWithNewline ? text.slice(0, -1) : text;
  return { line: body.slice(body.lastIndexOf("\n") + 1), endsWithNewline };
}

/** Hash a line links to: its `hash`, or for lines written before the chain, the hash of the raw line. */
function linkHash(raw: string): string {
  try {
    const v = JSON.parse(raw) as { hash?: unknown };
    if (typeof v.hash === "string") return v.hash;
  } catch {
    // Not JSON: link to the raw text.
  }
  return `sha256:${sha256Hex(raw)}`;
}

export class JsonlAuditLog implements AuditSink {
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  write(entry: AuditEntry): void {
    withLock(`${this.path}.lock`, () => {
      const fd = openSync(this.path, "a+");
      try {
        const t = tail(fd);
        const prev = t.line === undefined ? AUDIT_GENESIS : linkHash(t.line);
        const chained = { ...entry, prev };
        const line = JSON.stringify({ ...chained, hash: digest(chained) });
        writeSync(fd, `${t.endsWithNewline ? "" : "\n"}${line}\n`);
      } finally {
        closeSync(fd);
      }
    });
  }
}

export interface AuditVerifyResult {
  ok: boolean;
  /** Lines checked. */
  lines: number;
  /** Lines at the start written before the chain (ADTL 0.4 and earlier). */
  unchained: number;
  /** Hash of the last line: note it to detect lines cut off the end later. */
  last?: string;
  problem?: string;
}

/** Check every line's hash and its link to the line before. */
export function verifyAuditLog(path: string): AuditVerifyResult {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  let prev = AUDIT_GENESIS;
  let unchained = 0;
  let chained = false;
  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const fail = (problem: string): AuditVerifyResult => ({ ok: false, lines: n, unchained, problem: `line ${n} ${problem}` });
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail("is not valid JSON");
    }
    const { hash, ...rest } = v;
    if (typeof hash !== "string") {
      if (chained) return fail("has no hash: it was inserted or edited");
      unchained++;
      prev = linkHash(raw);
      continue;
    }
    chained = true;
    if (rest.prev !== prev) return fail(`doesn't follow line ${n - 1 || "(start)"}: a line was removed, reordered or inserted`);
    if (digest(rest) !== hash) return fail("was changed after it was written");
    prev = hash;
  }
  return { ok: true, lines: lines.length, unchained, ...(lines.length ? { last: prev } : {}) };
}

export class MemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];
  write(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}
