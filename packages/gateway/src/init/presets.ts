/**
 * Presets for well-known MCP servers, used by `adtl-gateway init`.
 *
 * A preset says what a server's reads and writes mean, and the server's own
 * `readOnlyHint` decides which tools are reads. That keeps a preset correct as
 * the server adds tools (the GitHub server has about 90 and adds more).
 *
 * Presets are only a starting point: `init` writes one explicit line per tool
 * into adtl.yaml, and the gateway owner reviews and edits them.
 */
import type { ToolRule } from "@adtl/labels";

export interface Preset {
  id: string;
  /** `serverInfo.name` values the server reports at initialize. */
  serverNames: string[];
  /** Server defaults: resources, prompts, and tools added after `init` ran. */
  defaults: ToolRule;
  /** Tools with `readOnlyHint: true`. */
  read: ToolRule;
  /** All other tools. Fields left out fall back to `defaults`. */
  write: ToolRule;
  /** Exact per-tool overrides. */
  tools?: Record<string, ToolRule>;
  /** One line written above the server in adtl.yaml. */
  note: string;
}

export const PRESETS: Preset[] = [
  {
    id: "github",
    serverNames: ["github-mcp-server"],
    // Issues, PRs, comments and code can be written by anyone who can open an issue.
    defaults: { integrity: "untrusted", confidentiality: "private", egress: "public" },
    read: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
    write: { egress: "public" },
    note: "preset github: content is untrusted (anyone can write issues), private repos make it private; writes are public",
  },
  {
    id: "filesystem",
    serverNames: ["secure-filesystem-server"],
    defaults: { integrity: "trusted", confidentiality: "private", egress: "internal" },
    read: { integrity: "trusted", confidentiality: "private", egress: "none" },
    write: { egress: "internal" },
    note: "preset filesystem: files are trusted; set integrity: untrusted if these folders hold downloads or cloned repos",
  },
  {
    id: "fetch",
    serverNames: ["mcp-fetch"],
    // The URL itself can carry data out, so even a read is external egress.
    defaults: { integrity: "untrusted", confidentiality: "public", egress: "external" },
    read: { integrity: "untrusted", confidentiality: "public", egress: "external" },
    write: { integrity: "untrusted", confidentiality: "public", egress: "external" },
    note: "preset fetch: web pages are untrusted; a fetched URL can carry data out, so fetch is external egress",
  },
];

/** The preset for an upstream: by the name the server reports, then by the upstream id. */
export function choosePreset(upstreamId: string, serverName: string | undefined, presets = PRESETS): Preset | undefined {
  return (
    (serverName !== undefined ? presets.find((p) => p.serverNames.includes(serverName)) : undefined) ??
    presets.find((p) => p.id === upstreamId)
  );
}
