/**
 * Fingerprints of secret-like values, for the `call.copiesPrivate` policy
 * condition: does a call's arguments hold a value the session read earlier
 * from a private source?
 *
 * A session label can't tell a leaking write from a normal one, because
 * nearly every session is already private. Copied values can: a token read
 * from `.env` and then written into a report is the leak.
 *
 * Only values that look like secrets count: unbroken runs of 16 or more
 * characters (letters, digits, `_`, `-`, `+`, then any `=` padding) with both
 * letters and digits, that aren't plain hex and aren't a folder name in a
 * path. That leaves out prose, snake_case names, UUIDs, workspace folders, and
 * the git commit ids and content hashes that tasks copy all the time.
 * Measured on MCPHunt's traces: see examples/mcphunt-eval.
 *
 * Only hashes are kept, never the values.
 */
import { createHash } from "node:crypto";

export const MIN_SECRET_CHARS = 16;
/** Upper bound on fingerprints taken from one value, so one huge result can't flood session state. */
export const MAX_FINGERPRINTS = 2000;
/** Upper bound on characters read from one value. */
const MAX_CHARS = 2_000_000;

const TOKEN = /[A-Za-z0-9_+-]{16,}=*/g;
const HEX = /^[0-9a-f]+$/i;

/** True if `token` looks like a secret: has letters and digits, and isn't plain hex (hyphens aside, so UUIDs don't count). */
export function isSecretLike(token: string): boolean {
  return token.length >= MIN_SECRET_CHARS && /[A-Za-z]/.test(token) && /\d/.test(token) && !HEX.test(token.replace(/[-=]/g, ""));
}

/**
 * The secret-like tokens in `text`, distinct, in order of first appearance.
 * Folder names (a token right before `/`) don't count: every path a task
 * writes to repeats its workspace folder.
 */
export function secretLikeTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TOKEN)) {
    if (text[m.index + m[0].length] === "/") continue;
    if (isSecretLike(m[0])) out.add(m[0]);
  }
  return [...out];
}

function strings(value: unknown): string[] {
  const out: string[] = [];
  let total = 0;
  const seen = new Set<object>();
  const walk = (v: unknown): void => {
    if (total >= MAX_CHARS) return;
    if (typeof v === "string") {
      const s = v.slice(0, MAX_CHARS - total);
      total += s.length;
      out.push(s);
    } else if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return;
      seen.add(v);
      for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x);
    }
  };
  walk(value);
  return out;
}

/** Hash of one value as kept in session state: 128 bits of SHA-256, hex. */
export function valueFingerprint(token: string): string {
  return createHash("sha256").update(`adtl.value.v1\n${token}`, "utf8").digest("hex").slice(0, 32);
}

/** Fingerprints of every secret-like token in the strings inside `value` (objects and arrays are walked). */
export function secretFingerprints(value: unknown): string[] {
  const out = new Set<string>();
  for (const s of strings(value)) {
    for (const t of secretLikeTokens(s)) {
      out.add(valueFingerprint(t));
      if (out.size >= MAX_FINGERPRINTS) return [...out];
    }
  }
  return [...out];
}
