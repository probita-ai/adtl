/**
 * Which session a Claude Code sub-agent belongs to.
 *
 * Claude Code's SubagentStart hook reports the parent's `session_id` with the
 * new sub-agent's `agent_id`. Recording that link lets the sub-agent's later
 * hook calls use the parent's label even if they ever report a session id of
 * their own: the sub-agent starts from what its parent has seen, and what it
 * reads taints the parent. Links live beside the session files, which the
 * hooks already protect from the agent.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface AgentLinks {
  /** The session `agentId` was started in, if known. */
  parentOf(agentId: string): string | undefined;
  link(agentId: string, sessionId: string): void;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class FileAgentLinks implements AgentLinks {
  private readonly dir: string;

  constructor(sessionsDir: string) {
    this.dir = join(sessionsDir, "agents");
  }

  private pathOf(agentId: string): string {
    const name = SAFE_ID.test(agentId) ? agentId : `h-${createHash("sha256").update(agentId).digest("hex")}`;
    return join(this.dir, `${name}.parent`);
  }

  parentOf(agentId: string): string | undefined {
    try {
      return readFileSync(this.pathOf(agentId), "utf8").trim() || undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  link(agentId: string, sessionId: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.pathOf(agentId), sessionId, { encoding: "utf8", mode: 0o600 });
  }
}

export class InMemoryAgentLinks implements AgentLinks {
  private readonly links = new Map<string, string>();
  parentOf(agentId: string): string | undefined {
    return this.links.get(agentId);
  }
  link(agentId: string, sessionId: string): void {
    this.links.set(agentId, sessionId);
  }
}
