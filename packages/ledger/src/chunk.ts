/**
 * Turn text into content hashes that survive copying.
 *
 * Text is normalized (Unicode NFC, lowercase, whitespace collapsed), then
 * hashed whole, per paragraph and per line. Pieces shorter than
 * MIN_CHUNK_CHARS are skipped, so lines like `}` or `## Usage` don't match
 * everything. A paragraph copied into a bigger file still matches.
 */
import { createHash } from "node:crypto";

export const MIN_CHUNK_CHARS = 32;
/** Upper bound on hashes per text, so one huge input can't flood the ledger. */
export const MAX_CHUNKS = 5000;
/** Upper bound on characters of text taken from one value. */
export const MAX_TEXT_CHARS = 2_000_000;

export function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Distinct hashes of the text, its paragraphs and its lines (each normalized, long enough). */
export function chunkHashes(text: string): string[] {
  const pieces = [text, ...text.split(/\n\s*\n/), ...text.split("\n")];
  const out = new Set<string>();
  for (const p of pieces) {
    const n = normalize(p);
    if (n.length < MIN_CHUNK_CHARS) continue;
    out.add(sha256(n));
    if (out.size >= MAX_CHUNKS) break;
  }
  return [...out];
}

/** Every string inside `value` (objects, arrays, nested), up to MAX_TEXT_CHARS in total. */
export function textLeaves(value: unknown): string[] {
  const out: string[] = [];
  let total = 0;
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (total >= MAX_TEXT_CHARS) return;
    if (typeof v === "string") {
      const s = v.slice(0, MAX_TEXT_CHARS - total);
      total += s.length;
      out.push(s);
    } else if (Array.isArray(v)) {
      if (seen.has(v)) return;
      seen.add(v);
      v.forEach(walk);
    } else if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return;
      seen.add(v);
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return out;
}

/** Distinct chunk hashes of every string inside `value`. */
export function valueHashes(value: unknown): string[] {
  const out = new Set<string>();
  for (const t of textLeaves(value)) {
    for (const h of chunkHashes(t)) {
      out.add(h);
      if (out.size >= MAX_CHUNKS) return [...out];
    }
  }
  return [...out];
}
