/**
 * Session label state shared between processes through files, so that
 * adtl-gateway (via adtl-interceptors) and Claude Code hooks see one label per
 * agent session.
 *
 * Each session is an append-only JSONL file: one line per observed label. The
 * session label is the join of every line. Appending small lines needs no lock,
 * and since a join never relaxes a label, two processes writing at once can't
 * lose each other's taint. A line that can't be parsed counts as untrusted and
 * private, so a damaged file fails closed.
 *
 * Fingerprints of private values (for `call.copiesPrivate`) go to a second
 * append-only file per session, `<id>.values`, one hash per line.
 */
import { appendFileSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { CONFIDENTIALITY_LEVELS, INTEGRITY_LEVELS, join, joinAll, type Label } from "./label.js";
import type { SessionStore } from "./session.js";

/** `ADTL_SESSIONS_DIR`, or `~/.adtl/sessions`. */
export function defaultSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADTL_SESSIONS_DIR?.trim() || joinPath(homedir(), ".adtl", "sessions");
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const DAMAGED: Label = {
  integrity: "untrusted",
  confidentiality: "private",
  origins: [{ server: "adtl", resource: "damaged-session-entry" }],
};

function parseLine(line: string): Label {
  try {
    const v = JSON.parse(line) as Partial<Label>;
    if (
      INTEGRITY_LEVELS.includes(v.integrity as never) &&
      CONFIDENTIALITY_LEVELS.includes(v.confidentiality as never) &&
      Array.isArray(v.origins)
    ) {
      return { integrity: v.integrity!, confidentiality: v.confidentiality!, origins: v.origins };
    }
  } catch {
    // fall through
  }
  return DAMAGED;
}

export class FileSessionStore implements SessionStore {
  constructor(readonly dir: string = defaultSessionsDir()) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** File holding `sessionId`. Ids that aren't plain names are hashed, so they can't escape `dir`. */
  pathOf(sessionId: string): string {
    return joinPath(this.dir, `${this.nameOf(sessionId)}.jsonl`);
  }

  /** File holding the session's private-value fingerprints. */
  valuesPathOf(sessionId: string): string {
    return joinPath(this.dir, `${this.nameOf(sessionId)}.values`);
  }

  private nameOf(sessionId: string): string {
    return SAFE_ID.test(sessionId) ? sessionId : `h-${createHash("sha256").update(sessionId).digest("hex")}`;
  }

  get(sessionId: string): Label {
    let text: string;
    try {
      text = readFileSync(this.pathOf(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return joinAll([]);
      throw err;
    }
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    return joinAll(lines.map(parseLine));
  }

  observe(sessionId: string, label: Label): Label {
    appendFileSync(this.pathOf(sessionId), `${JSON.stringify(label)}\n`, { encoding: "utf8", mode: 0o600 });
    return join(this.get(sessionId), label);
  }

  reset(sessionId: string): void {
    for (const path of [this.pathOf(sessionId), this.valuesPathOf(sessionId)]) {
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }

  rememberPrivateValues(sessionId: string, fingerprints: readonly string[]): void {
    if (fingerprints.length === 0) return;
    appendFileSync(this.valuesPathOf(sessionId), `${fingerprints.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  }

  hasPrivateValue(sessionId: string, fingerprints: readonly string[]): boolean {
    if (fingerprints.length === 0) return false;
    let text: string;
    try {
      text = readFileSync(this.valuesPathOf(sessionId), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
    const known = new Set(text.split("\n"));
    return fingerprints.some((f) => known.has(f));
  }
}
