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
  {
    id: "slack",
    // Both popular servers report this name: @modelcontextprotocol/server-slack (no tool hints, so its
    // tools are listed below) and korotovsky/slack-mcp-server (marks reads with readOnlyHint).
    serverNames: ["Slack MCP Server"],
    // Anyone in the workspace, or a shared channel, can write messages and profiles.
    defaults: { integrity: "untrusted", confidentiality: "private", egress: "external" },
    read: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
    write: { egress: "external" },
    tools: {
      slack_list_channels: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      slack_get_channel_history: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      slack_get_thread_replies: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      slack_get_users: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      slack_get_user_profile: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      slack_post_message: { integrity: "trusted", confidentiality: "public", egress: "external" },
      slack_reply_to_thread: { integrity: "trusted", confidentiality: "public", egress: "external" },
      slack_add_reaction: { integrity: "trusted", confidentiality: "public", egress: "external" },
    },
    note: "preset slack: messages are untrusted (anyone in the workspace can write them) and private; posting is external egress (set public for channels with outside guests)",
  },
  {
    id: "gmail",
    // @gongrzhe/server-gmail-autoauth-mcp, the most used Gmail server. It sets no tool hints.
    serverNames: ["gmail"],
    // Anyone can send you email.
    defaults: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
    read: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
    write: { egress: "internal" },
    tools: {
      read_email: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      search_emails: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      list_email_labels: { integrity: "untrusted", confidentiality: "private", egress: "none" },
      list_filters: { integrity: "trusted", confidentiality: "private", egress: "none" },
      get_filter: { integrity: "trusted", confidentiality: "private", egress: "none" },
      // Saves the attachment to a local folder.
      download_attachment: { integrity: "untrusted", confidentiality: "private", egress: "internal" },
      send_email: { integrity: "trusted", confidentiality: "public", egress: "external" },
      draft_email: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      modify_email: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      delete_email: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      batch_modify_emails: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      batch_delete_emails: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      create_label: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      update_label: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      delete_label: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      get_or_create_label: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      delete_filter: { integrity: "trusted", confidentiality: "public", egress: "internal" },
      // Filters can forward matching mail to any address.
      create_filter: { integrity: "trusted", confidentiality: "public", egress: "external" },
      create_filter_from_template: { integrity: "trusted", confidentiality: "public", egress: "external" },
    },
    note: "preset gmail: email is untrusted (anyone can send it) and private; sending, and filters that can forward mail, are external egress",
  },
];

/** The preset for an upstream: by the name the server reports, then by the upstream id. */
export function choosePreset(upstreamId: string, serverName: string | undefined, presets = PRESETS): Preset | undefined {
  return (
    (serverName !== undefined ? presets.find((p) => p.serverNames.includes(serverName)) : undefined) ??
    presets.find((p) => p.id === upstreamId)
  );
}
