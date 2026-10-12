/**
 * Decide the label of a tool or resource result.
 *
 * Order of authority:
 * 1. The gateway owner's config (tool rule, then server defaults).
 * 2. The tool's `openWorldHint` annotation (open-world tools are untrusted).
 * 3. The global default (restrictive: untrusted + private).
 *
 * Server-provided trust-annotations are then applied:
 * - Claims that make the label stricter are always accepted.
 * - Claims that relax it are accepted only from servers with
 *   `acceptServerClaims: true`, and never override an explicit config rule.
 *
 * The MCP spec says annotations from untrusted servers must not be trusted,
 * which is why relaxing claims need an explicit allowlist.
 */
import type { AdtlConfig, Egress, ToolRule } from "./config.js";
import { higherConfidentiality, type Confidentiality, type Integrity, type Label } from "./label.js";
import { readClaims } from "./trustAnnotations.js";

export interface LabelInput {
  server: string;
  /** Tool name, for tools/call results. */
  tool?: string;
  /** Resource URI, for resources/read results. */
  resource?: string;
  /** The raw result returned by the upstream server. */
  result: unknown;
  /** MCP tool annotations from tools/list, if known. */
  toolAnnotations?: { openWorldHint?: boolean };
}

function toolRule(config: AdtlConfig, server: string, tool?: string): ToolRule | undefined {
  if (tool === undefined) return undefined;
  return config.servers[server]?.tools[tool];
}

export function labelResult(input: LabelInput, config: AdtlConfig): Label {
  const server = config.servers[input.server];
  const rule = toolRule(config, input.server, input.tool);

  const configuredIntegrity: Integrity | undefined = rule?.integrity ?? server?.defaults?.integrity;
  const configuredConfidentiality: Confidentiality | undefined =
    rule?.confidentiality ?? server?.defaults?.confidentiality;

  let integrity: Integrity =
    configuredIntegrity ??
    (input.toolAnnotations?.openWorldHint === true ? "untrusted" : config.defaults.integrity);
  let confidentiality: Confidentiality = configuredConfidentiality ?? config.defaults.confidentiality;

  const claims = readClaims(input.result);
  const mayRelax = server?.acceptServerClaims === true;

  if (claims.untrusted === true) integrity = "untrusted";
  else if (claims.untrusted === false && mayRelax && configuredIntegrity === undefined) integrity = "trusted";

  if (claims.sensitive === true) confidentiality = higherConfidentiality(confidentiality, "private");
  else if (claims.sensitive === false && mayRelax && configuredConfidentiality === undefined) confidentiality = "public";

  const origin: Label["origins"][number] = { server: input.server };
  if (input.tool !== undefined) origin.tool = input.tool;
  if (input.resource !== undefined) origin.resource = input.resource;

  return { integrity, confidentiality, origins: [origin] };
}

/** Where a tool can send data. Unconfigured tools are "unknown". */
export function toolEgress(config: AdtlConfig, server: string, tool: string): Egress {
  return toolRule(config, server, tool)?.egress ?? config.servers[server]?.defaults?.egress ?? "unknown";
}
