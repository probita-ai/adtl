/**
 * Session receipts: a signed summary of every call a session made through
 * the gateway and the Claude Code hooks, built from the hash-chained audit log.
 *
 * Agents can misreport what they did; the audit log is written outside the
 * model. A receipt names the session, lists each call (tool, outcome,
 * decision, approver, call hash, result label, and the hash of its audit log
 * line) with counts, and is signed with the machine's Ed25519 key. Anyone with
 * the public key can check it, and with the log at hand, that it lists every
 * line the session wrote between its first and last call.
 *
 * Receipts cover what crossed the gateway and the hooks, not everything the
 * agent did. Arguments and results are never included.
 */
import { readFileSync } from "node:fs";
import { verifyCanonical, signCanonical, type Signer } from "@adtl/labels";
import { verifyAuditLog, type AuditEntry } from "./audit.js";

export const RECEIPT_TYPE = "adtl.receipt.v1";

export interface ReceiptCall {
  ts: string;
  event: AuditEntry["event"];
  server: string;
  tool?: string;
  resource?: string;
  prompt?: string;
  outcome: AuditEntry["outcome"];
  decision?: string;
  approver?: string;
  callHash?: string;
  /** Integrity and confidentiality of the result. */
  label?: { integrity: string; confidentiality: string };
  /** Hash of this call's audit log line. */
  line: string;
}

export interface Receipt {
  type: typeof RECEIPT_TYPE;
  sessionId: string;
  createdAt: string;
  counts: { calls: number; forwarded: number; blocked: number; asked: number; upstreamErrors: number; approved: number; denied: number };
  calls: ReceiptCall[];
  /** Public key that signed it, `ed25519:…`. */
  signer: string;
  signature: string;
}

type ChainedEntry = AuditEntry & { hash: string };

function chainedEntries(logPath: string): ChainedEntry[] {
  const v = verifyAuditLog(logPath);
  if (!v.ok) throw new Error(`${logPath}: the audit log was tampered with (${v.problem}); refusing to issue a receipt`);
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Partial<ChainedEntry>)
    .filter((e): e is ChainedEntry => typeof e.hash === "string" && typeof e.sessionId === "string");
}

/** Sessions in the audit log, with their number of calls and last activity. */
export function listSessions(logPath: string): { sessionId: string; calls: number; last: string }[] {
  const out = new Map<string, { sessionId: string; calls: number; last: string }>();
  for (const e of chainedEntries(logPath)) {
    const s = out.get(e.sessionId) ?? { sessionId: e.sessionId, calls: 0, last: e.ts };
    s.calls++;
    if (e.ts > s.last) s.last = e.ts;
    out.set(e.sessionId, s);
  }
  return [...out.values()].sort((a, b) => b.last.localeCompare(a.last));
}

function receiptCall(e: ChainedEntry): ReceiptCall {
  const label = e.label as { integrity?: unknown; confidentiality?: unknown } | undefined;
  return {
    ts: e.ts,
    event: e.event,
    server: e.server,
    ...(e.tool !== undefined ? { tool: e.tool } : {}),
    ...(e.resource !== undefined ? { resource: e.resource } : {}),
    ...(e.prompt !== undefined ? { prompt: e.prompt } : {}),
    outcome: e.outcome,
    ...(e.decision !== undefined ? { decision: e.decision } : {}),
    ...(e.approval?.approver !== undefined ? { approver: e.approval.approver } : {}),
    ...(typeof e.callHash === "string" ? { callHash: e.callHash } : {}),
    ...(typeof label?.integrity === "string" && typeof label.confidentiality === "string"
      ? { label: { integrity: label.integrity, confidentiality: label.confidentiality } }
      : {}),
    line: e.hash,
  };
}

/** Build and sign the receipt for `sessionId` from a verified audit log. */
export function buildReceipt(logPath: string, sessionId: string, signer: Signer, now: Date = new Date()): Receipt {
  const entries = chainedEntries(logPath).filter((e) => e.sessionId === sessionId);
  if (entries.length === 0) throw new Error(`${logPath} has no entries for session ${sessionId}`);
  const count = (f: (e: ChainedEntry) => boolean) => entries.filter(f).length;
  const unsigned: Omit<Receipt, "signature"> = {
    type: RECEIPT_TYPE,
    sessionId,
    createdAt: now.toISOString(),
    counts: {
      calls: entries.length,
      forwarded: count((e) => e.outcome === "forwarded"),
      blocked: count((e) => e.outcome === "blocked"),
      asked: count((e) => e.outcome === "asked"),
      upstreamErrors: count((e) => e.outcome === "upstream_error"),
      approved: count((e) => e.approval?.outcome === "approved"),
      denied: count((e) => e.approval?.outcome === "denied"),
    },
    calls: entries.map(receiptCall),
    signer: signer.publicKey,
  };
  return { ...unsigned, signature: signCanonical(signer, unsigned) };
}

export interface ReceiptCheck {
  ok: boolean;
  problem?: string;
}

/**
 * Check a receipt's signature, that it is signed by `trustedKey` if given,
 * and, with `logPath`, that the log is intact and the receipt lists exactly
 * the session's lines from its first call to its last.
 */
export function verifyReceipt(receipt: Receipt, opts: { logPath?: string; trustedKey?: string } = {}): ReceiptCheck {
  const { signature, ...unsigned } = receipt;
  if (receipt.type !== RECEIPT_TYPE) return { ok: false, problem: `not an ADTL receipt (type ${String(receipt.type)})` };
  if (!verifyCanonical(receipt.signer, unsigned, signature)) return { ok: false, problem: "the signature doesn't match: the receipt was changed or forged" };
  if (opts.trustedKey && receipt.signer !== opts.trustedKey) return { ok: false, problem: `signed by ${receipt.signer}, not the expected key` };
  if (!opts.logPath) return { ok: true };
  let entries: ChainedEntry[];
  try {
    entries = chainedEntries(opts.logPath);
  } catch (err) {
    return { ok: false, problem: (err as Error).message };
  }
  const lines = receipt.calls.map((c) => c.line);
  const first = entries.findIndex((e) => e.hash === lines[0]);
  const last = entries.findIndex((e) => e.hash === lines.at(-1));
  if (first < 0 || last < 0) return { ok: false, problem: "the log doesn't contain the receipt's calls" };
  const logged = entries.slice(first, last + 1).filter((e) => e.sessionId === receipt.sessionId);
  if (logged.length !== lines.length || logged.some((e, i) => e.hash !== lines[i])) {
    return { ok: false, problem: "the receipt doesn't list exactly the session's calls in the log" };
  }
  return { ok: true };
}
