/**
 * Per-session label state: the join of every label a session has observed.
 *
 * Session labels only get stricter. The one way to relax them is an explicit
 * `reset`, which callers should reserve for a human-approved declassify step.
 */
import { EMPTY_LABEL, join, type Label } from "./label.js";

export interface SessionStore {
  get(sessionId: string): Label;
  /** Join `label` into the session and return the new session label. */
  observe(sessionId: string, label: Label): Label;
  reset(sessionId: string): void;
  /**
   * Remember fingerprints (see values.ts) of secret-like values the session
   * read from a private source. Optional: without it, `call.copiesPrivate`
   * can't be known and counts as true.
   */
  rememberPrivateValues?(sessionId: string, fingerprints: readonly string[]): void;
  /** True if any of `fingerprints` was remembered for the session. */
  hasPrivateValue?(sessionId: string, fingerprints: readonly string[]): boolean;
}

function emptyLabel(): Label {
  return { ...EMPTY_LABEL, origins: [] };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Label>();
  private readonly values = new Map<string, Set<string>>();

  get(sessionId: string): Label {
    return this.sessions.get(sessionId) ?? emptyLabel();
  }

  observe(sessionId: string, label: Label): Label {
    const next = join(this.get(sessionId), label);
    this.sessions.set(sessionId, next);
    return next;
  }

  reset(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.values.delete(sessionId);
  }

  rememberPrivateValues(sessionId: string, fingerprints: readonly string[]): void {
    if (fingerprints.length === 0) return;
    let set = this.values.get(sessionId);
    if (!set) this.values.set(sessionId, (set = new Set()));
    for (const f of fingerprints) set.add(f);
  }

  hasPrivateValue(sessionId: string, fingerprints: readonly string[]): boolean {
    const set = this.values.get(sessionId);
    return !!set && fingerprints.some((f) => set.has(f));
  }
}
