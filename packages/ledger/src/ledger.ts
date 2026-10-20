/**
 * The label ledger: a SQLite file mapping content hashes to the label of the
 * session that wrote the content.
 *
 * - `record`: after a tainted session sends text anywhere (a file, a memory
 *   server, a sub-agent prompt), its chunk hashes are stored with the
 *   session's label. Clean sessions record nothing.
 * - `lookup`: before a result reaches the agent, its chunk hashes are looked
 *   up; matching labels are joined into the result's label.
 * - `declassify`: a human clears the label of specific content; lookups
 *   ignore records made before the clear.
 *
 * Entries are hash-chained (each entry hashes the previous one), so `verify`
 * detects edited or deleted entries. Pruning old entries keeps the chain
 * verifiable by remembering the hash of the last pruned entry.
 *
 * Several processes may use one file at once (gateway, interceptors, Claude
 * Code hooks); writes are serialized by SQLite with a busy timeout.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { CONFIDENTIALITY_LEVELS, INTEGRITY_LEVELS, join as joinLabels, type Label, type Origin } from "@adtl/labels";

// Loaded at runtime: some bundlers and test runners don't know node:sqlite is a builtin yet.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

/** `ADTL_LEDGER`, or `~/.adtl/ledger.db`. */
export function defaultLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADTL_LEDGER?.trim() || join(homedir(), ".adtl", "ledger.db");
}

export interface LedgerOptions {
  /** Entries older than this are pruned (at most once a day). Default 90. */
  retentionDays?: number;
  now?: () => Date;
}

export interface LedgerMatch {
  /** Join of the labels of every matching record. */
  label: Label;
  /** How many distinct chunks matched. */
  chunks: number;
  /** Sessions that wrote the matching content. */
  writers: string[];
}

/** One declassification: everything one person cleared at one time, for one reason. */
export interface Declassification {
  ts: string;
  by: string;
  reason?: string;
  /** What was cleared, e.g. a file name. */
  subject?: string;
  chunks: number;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  /** First problem found, if any. */
  problem?: string;
}

const GENESIS = "0".repeat(64);
const DAY_MS = 86_400_000;
/** SQLite's default limit on bound parameters is 32766; stay well below it. */
const BATCH = 500;

const DAMAGED: Label = {
  integrity: "untrusted",
  confidentiality: "private",
  origins: [{ server: "adtl-ledger", resource: "damaged-entry" }],
};

interface Row {
  seq: number;
  ts: string;
  kind: "record" | "clear";
  chunk: string;
  label: string | null;
  writer: string | null;
  source: string | null;
  prev: string;
  hash: string;
}

function entryHash(prev: string, r: Pick<Row, "ts" | "kind" | "chunk" | "label" | "writer" | "source">): string {
  return createHash("sha256")
    .update(`${prev}\n${JSON.stringify([r.ts, r.kind, r.chunk, r.label, r.writer, r.source])}`)
    .digest("hex");
}

function parseLabel(json: string | null): Label {
  try {
    const v = JSON.parse(json ?? "") as Partial<Label>;
    if (INTEGRITY_LEVELS.includes(v.integrity as never) && CONFIDENTIALITY_LEVELS.includes(v.confidentiality as never) && Array.isArray(v.origins)) {
      return { integrity: v.integrity!, confidentiality: v.confidentiality!, origins: v.origins };
    }
  } catch {
    // fall through
  }
  return DAMAGED;
}

/** A label that adds nothing when joined: nothing worth recording. */
export function isClean(label: Label): boolean {
  return label.integrity === "trusted" && label.confidentiality === "public";
}

export class Ledger {
  readonly path: string;
  private readonly db: DatabaseSyncType;
  private readonly now: () => Date;

  constructor(path: string = defaultLedgerPath(), opts: LedgerOptions = {}) {
    this.path = path;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // best effort (e.g. ":memory:")
    }
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS entries (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        ts     TEXT NOT NULL,
        kind   TEXT NOT NULL CHECK (kind IN ('record', 'clear')),
        chunk  TEXT NOT NULL,
        label  TEXT,
        writer TEXT,
        source TEXT,
        prev   TEXT NOT NULL,
        hash   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_chunk ON entries (chunk, seq);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.prune(opts.retentionDays ?? 90);
  }

  close(): void {
    this.db.close();
  }

  private meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Rows for `chunks`, oldest first. */
  private rowsFor(chunks: readonly string[]): Row[] {
    const out: Row[] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
      const part = chunks.slice(i, i + BATCH);
      const sql = `SELECT * FROM entries WHERE chunk IN (${part.map(() => "?").join(",")}) ORDER BY seq`;
      out.push(...(this.db.prepare(sql).all(...part) as unknown as Row[]));
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /** Live records (made after the chunk's last clear), per chunk. */
  private live(chunks: readonly string[]): Map<string, Row[]> {
    const byChunk = new Map<string, Row[]>();
    for (const r of this.rowsFor(chunks)) {
      if (r.kind === "clear") byChunk.set(r.chunk, []);
      else byChunk.set(r.chunk, [...(byChunk.get(r.chunk) ?? []), r]);
    }
    return byChunk;
  }

  private append(rows: Omit<Row, "seq" | "prev" | "hash">[]): number {
    if (rows.length === 0) return 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT hash FROM entries ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
      let prev = last?.hash ?? this.meta("pruned_hash") ?? GENESIS;
      const insert = this.db.prepare(
        "INSERT INTO entries (ts, kind, chunk, label, writer, source, prev, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      for (const r of rows) {
        const hash = entryHash(prev, r);
        insert.run(r.ts, r.kind, r.chunk, r.label, r.writer, r.source, prev, hash);
        prev = hash;
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return rows.length;
  }

  /**
   * Remember that `writer` (a session id) produced the content with these
   * chunk hashes while its label was `label`. Returns the number of new entries.
   */
  record(chunks: readonly string[], label: Label, writer: string, source?: Origin): number {
    if (isClean(label) || chunks.length === 0) return 0;
    const labelJson = JSON.stringify({ integrity: label.integrity, confidentiality: label.confidentiality, origins: label.origins });
    const live = this.live([...new Set(chunks)]);
    const ts = this.now().toISOString();
    const sourceJson = source ? JSON.stringify(source) : null;
    const rows = [...new Set(chunks)]
      .filter((c) => !(live.get(c) ?? []).some((r) => r.label === labelJson && r.writer === writer))
      .map((chunk) => ({ ts, kind: "record" as const, chunk, label: labelJson, writer, source: sourceJson }));
    return this.append(rows);
  }

  /** The joined label of every live record matching these chunk hashes, or undefined if none match. */
  lookup(chunks: readonly string[]): LedgerMatch | undefined {
    if (chunks.length === 0) return undefined;
    let label: Label | undefined;
    let matched = 0;
    const writers = new Set<string>();
    for (const rows of this.live([...new Set(chunks)]).values()) {
      if (rows.length === 0) continue;
      matched++;
      for (const r of rows) {
        const l = parseLabel(r.label);
        const origin: Origin = { server: "adtl-ledger", resource: `session:${r.writer ?? "unknown"}` };
        label = joinLabels(label ?? { ...l, origins: [] }, { ...l, origins: [...l.origins, origin] });
        if (r.writer) writers.add(r.writer);
      }
    }
    return label ? { label, chunks: matched, writers: [...writers] } : undefined;
  }

  /**
   * Clear the label of content with these chunk hashes. `by` names who did it,
   * `subject` what was cleared (e.g. a file name). Returns the number of chunks cleared.
   */
  declassify(chunks: readonly string[], by: string, reason?: string, subject?: string): number {
    const live = this.live([...new Set(chunks)]);
    const ts = this.now().toISOString();
    const why = reason || subject ? JSON.stringify({ ...(reason ? { reason } : {}), ...(subject ? { subject } : {}) }) : null;
    const rows = [...live.entries()]
      .filter(([, rs]) => rs.length > 0)
      .map(([chunk]) => ({ ts, kind: "clear" as const, chunk, label: null, writer: by, source: why }));
    return this.append(rows);
  }

  /** Recent declassifications, newest first, for review. */
  declassifications(limit = 20): Declassification[] {
    const rows = this.db
      .prepare("SELECT ts, writer, source, COUNT(*) AS chunks FROM entries WHERE kind = 'clear' GROUP BY ts, writer, source ORDER BY ts DESC LIMIT ?")
      .all(limit) as unknown as { ts: string; writer: string | null; source: string | null; chunks: number }[];
    return rows.map((r) => {
      let s: { reason?: unknown; subject?: unknown } = {};
      try {
        s = JSON.parse(r.source ?? "{}") as typeof s;
      } catch {
        // Unreadable source: list it without a reason.
      }
      return {
        ts: r.ts,
        by: r.writer ?? "unknown",
        ...(typeof s.reason === "string" ? { reason: s.reason } : {}),
        ...(typeof s.subject === "string" ? { subject: s.subject } : {}),
        chunks: r.chunks,
      };
    });
  }

  /** Check every entry's hash and its link to the one before. */
  verify(): VerifyResult {
    let prev = this.meta("pruned_hash") ?? GENESIS;
    let n = 0;
    let lastSeq = 0;
    for (const r of this.db.prepare("SELECT * FROM entries ORDER BY seq").all() as unknown as Row[]) {
      n++;
      if (r.prev !== prev) return { ok: false, entries: n, problem: `entry ${r.seq} doesn't follow entry ${lastSeq || "(start)"}: an entry was removed or changed` };
      if (entryHash(r.prev, r) !== r.hash) return { ok: false, entries: n, problem: `entry ${r.seq} was changed after it was written` };
      prev = r.hash;
      lastSeq = r.seq;
    }
    return { ok: true, entries: n };
  }

  stats(): { entries: number; records: number; clears: number; writers: number } {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS entries, SUM(kind = 'record') AS records, SUM(kind = 'clear') AS clears, COUNT(DISTINCT CASE WHEN kind = 'record' THEN writer END) AS writers FROM entries",
      )
      .get() as { entries: number; records: number | null; clears: number | null; writers: number };
    return { entries: row.entries, records: row.records ?? 0, clears: row.clears ?? 0, writers: row.writers };
  }

  /** Forget entries older than `days`, at most once a day. */
  private prune(days: number): void {
    const now = this.now();
    const last = this.meta("pruned_at");
    if (last && now.getTime() - Date.parse(last) < DAY_MS) return;
    const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lastOld = this.db.prepare("SELECT seq, hash FROM entries WHERE ts < ? ORDER BY seq DESC LIMIT 1").get(cutoff) as
        | { seq: number; hash: string }
        | undefined;
      if (lastOld) {
        this.db.prepare("DELETE FROM entries WHERE seq <= ?").run(lastOld.seq);
        this.setMeta("pruned_hash", lastOld.hash);
      }
      this.setMeta("pruned_at", now.toISOString());
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}
