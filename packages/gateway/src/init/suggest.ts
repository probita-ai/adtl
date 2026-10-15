/**
 * Draft ADTL rules for an upstream's tools, and merge them into adtl.yaml.
 *
 * Without a preset, rules come from the MCP tool annotations. Those are the
 * server's own claims, so they only decide egress; integrity is always
 * untrusted and confidentiality private until the owner says otherwise.
 * Missing hints take the MCP spec defaults (readOnlyHint false, openWorldHint true).
 *
 * Merging never changes an entry that is already in the file: the owner's
 * choices win, and `init` can be re-run to pick up new tools.
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolRule } from "@adtl/labels";
import { isMap, isScalar, type Document, type YAMLMap } from "yaml";
import { choosePreset, PRESETS, type Preset } from "./presets.js";

export interface ServerScan {
  /** Upstream id in gateway.upstreams. */
  id: string;
  /** `serverInfo.name` the server reported. */
  serverName?: string;
  tools: Pick<Tool, "name" | "annotations">[];
}

export interface ToolSuggestion {
  name: string;
  rule: ToolRule;
  /** Short reason, written as a comment next to the rule. */
  why: string;
}

export interface ServerSuggestion {
  id: string;
  preset?: Preset;
  defaults: ToolRule;
  tools: ToolSuggestion[];
}

const UNKNOWN_DEFAULTS: ToolRule = { integrity: "untrusted", confidentiality: "private" };

/** A rule from the tool's MCP annotations alone. */
export function ruleFromHints(annotations: Tool["annotations"]): Omit<ToolSuggestion, "name"> {
  const readOnly = annotations?.readOnlyHint === true;
  const openWorld = annotations?.openWorldHint !== false;
  const egress = readOnly ? (openWorld ? "external" : "none") : openWorld ? "public" : "internal";
  const why = `hints: ${readOnly ? "read-only" : "writes"}, ${openWorld ? "open world" : "closed world"} (review)`;
  return { rule: { integrity: "untrusted", confidentiality: "private", egress }, why };
}

export function suggest(scan: ServerScan, presets = PRESETS): ServerSuggestion {
  const preset = choosePreset(scan.id, scan.serverName, presets);
  const tools = scan.tools.map(({ name, annotations }): ToolSuggestion => {
    if (!preset) return { name, ...ruleFromHints(annotations) };
    const override = preset.tools?.[name];
    if (override) return { name, rule: override, why: `preset ${preset.id}` };
    const read = annotations?.readOnlyHint === true;
    return { name, rule: read ? preset.read : preset.write, why: `preset ${preset.id}: ${read ? "read" : "write"}` };
  });
  return { id: scan.id, ...(preset ? { preset } : {}), defaults: preset?.defaults ?? UNKNOWN_DEFAULTS, tools };
}

export interface MergeReport {
  id: string;
  preset?: string;
  added: string[];
  /** Tools already configured; left as they were. */
  kept: string[];
  /** Configured tools the server no longer offers. Left in place, reported only. */
  stale: string[];
  addedDefaults: boolean;
}

function mapAt(doc: Document, parent: YAMLMap, key: string, commentBefore?: string): YAMLMap {
  const existing = parent.get(key, true);
  if (isMap(existing)) return existing;
  const map = doc.createNode({}) as YAMLMap;
  const k = doc.createNode(key);
  if (commentBefore && isScalar(k)) k.commentBefore = ` ${commentBefore}`;
  parent.add(doc.createPair(k, map));
  return map;
}

/** Add the suggestions to the document's `servers:` section, keeping every existing entry. */
export function mergeIntoDocument(doc: Document, suggestions: ServerSuggestion[]): MergeReport[] {
  let servers = doc.get("servers", true);
  if (!isMap(servers)) {
    servers = doc.createNode({}) as YAMLMap;
    // Put servers: first, ahead of policy: and gateway:.
    const root = doc.contents;
    if (isMap(root)) root.items.unshift(doc.createPair("servers", servers));
    else doc.contents = doc.createNode({ servers }) as never;
  }
  const serversMap = servers as YAMLMap;

  return suggestions.map((s) => {
    const report: MergeReport = { id: s.id, added: [], kept: [], stale: [], addedDefaults: false };
    if (s.preset) report.preset = s.preset.id;
    const isNew = !serversMap.has(s.id);
    const server = mapAt(doc, serversMap, s.id, isNew ? (s.preset?.note ?? "from MCP tool hints: review every line") : undefined);

    if (!server.has("defaults")) {
      const d = doc.createNode(s.defaults, { flow: true });
      d.comment = " resources, prompts, and tools not listed below";
      server.items.unshift(doc.createPair("defaults", d));
      report.addedDefaults = true;
    }

    const tools = mapAt(doc, server, "tools");
    tools.flow = false;
    const offered = new Set(s.tools.map((t) => t.name));
    for (const t of s.tools) {
      if (tools.has(t.name)) {
        report.kept.push(t.name);
        continue;
      }
      const v = doc.createNode(t.rule, { flow: true });
      v.comment = ` ${t.why}`;
      tools.set(t.name, v);
      report.added.push(t.name);
    }
    for (const item of tools.items) {
      const name = isScalar(item.key) ? String(item.key.value) : String(item.key);
      if (!offered.has(name)) report.stale.push(name);
    }
    return report;
  });
}
