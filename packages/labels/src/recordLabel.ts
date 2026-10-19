/**
 * Labels carried on stored records, for servers that rewrite what they store.
 *
 * The ledger recognizes content by its hashes, so it loses the label when a
 * server stores something other than what was sent (a memory server that
 * extracts facts with a model, or merges records). For those servers the
 * label travels with the record instead:
 *
 * - On write, the gateway stamps the session's label into a per-item field
 *   the server keeps (tool rule `labelInto`, e.g. `metadata`), replacing any
 *   stamp the agent supplied.
 * - On read (tool rule `readLabels`), stamps found in the result are joined
 *   into its label. Anyone with access to the store can write a stamp, so a
 *   stamp can only make a label stricter. A malformed stamp counts as the
 *   global default.
 *
 * A server that drops or rewrites the field gets no help from this; give its
 * read tools a strict rule instead.
 */
import { CONFIDENTIALITY_LEVELS, INTEGRITY_LEVELS, join, type Label, type Origin } from "./label.js";

/** Key of the stamp inside the record's field. */
export const RECORD_LABEL_KEY = "adtl/record-label";

export interface RecordLabel {
  integrity: Label["integrity"];
  confidentiality: Label["confidentiality"];
  /** Session that wrote the record. */
  writer: string;
}

export interface CarriedLabels {
  label: Label;
  /** Stamps found, valid or not. */
  records: number;
  writers: string[];
}

/** Scanning limits, so a large or hostile result can't make labeling slow. */
const MAX_DEPTH = 32;
const MAX_NODES = 100_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Return `args` with `label` stamped into `args[field]`. Throws if the field
 * holds something other than an object, since the stamp would be lost.
 */
export function stampRecordLabel(args: Record<string, unknown>, field: string, label: Label, writer: string): Record<string, unknown> {
  const current = args[field];
  if (current !== undefined && !isRecord(current)) {
    throw new TypeError(`Cannot stamp the label into "${field}": it is not an object`);
  }
  const stamp: RecordLabel = { integrity: label.integrity, confidentiality: label.confidentiality, writer };
  return { ...args, [field]: { ...(current ?? {}), [RECORD_LABEL_KEY]: stamp } };
}

function parseStamp(v: unknown): RecordLabel | undefined {
  if (!isRecord(v)) return undefined;
  if (!INTEGRITY_LEVELS.includes(v.integrity as never) || !CONFIDENTIALITY_LEVELS.includes(v.confidentiality as never)) return undefined;
  if (typeof v.writer !== "string" || v.writer.length === 0) return undefined;
  return { integrity: v.integrity as Label["integrity"], confidentiality: v.confidentiality as Label["confidentiality"], writer: v.writer };
}

/**
 * Find stamps anywhere in a result, including inside text content that is
 * JSON (servers often return records that way). Returns undefined if none.
 */
export function readRecordLabels(result: unknown, defaults: Pick<Label, "integrity" | "confidentiality">): CarriedLabels | undefined {
  let label: Label | undefined;
  let records = 0;
  let nodes = 0;
  const writers = new Set<string>();

  const add = (l: Label) => {
    label = label ? join(label, l) : l;
  };

  const visit = (v: unknown, depth: number): void => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return;
    if (typeof v === "string") {
      const t = v.trimStart();
      if ((t.startsWith("{") || t.startsWith("[")) && v.includes(RECORD_LABEL_KEY)) {
        try {
          visit(JSON.parse(v), depth + 1);
        } catch {
          // Not JSON; ignore.
        }
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    if (!isRecord(v)) return;
    if (RECORD_LABEL_KEY in v) {
      records++;
      const s = parseStamp(v[RECORD_LABEL_KEY]);
      if (s) {
        writers.add(s.writer);
        const origin: Origin = { server: "adtl-record", resource: `session:${s.writer}` };
        add({ integrity: s.integrity, confidentiality: s.confidentiality, origins: [origin] });
      } else {
        add({ ...defaults, origins: [{ server: "adtl-record", resource: "malformed-stamp" }] });
      }
    }
    for (const [k, x] of Object.entries(v)) if (k !== RECORD_LABEL_KEY) visit(x, depth + 1);
  };

  visit(result, 0);
  return label ? { label, records, writers: [...writers] } : undefined;
}
