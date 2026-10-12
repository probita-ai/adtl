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
}

function emptyLabel(): Label {
  return { ...EMPTY_LABEL, origins: [] };
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Label>();

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
  }
}
