/**
 * Decide the label of a tool, resource or prompt result.
 *
 * Order of authority:
 * 1. The gateway owner's config (tool rule, then server defaults).
 * 2. The tool's draft `action-metadata` annotation (`returnMetadata.source`
 *    and `.sensitivity`), from servers with `acceptServerClaims: true`.
 * 3. The tool's `openWorldHint` annotation (open-world tools are untrusted).
 * 4. The global default (restrictive: untrusted + private).
 *
 * Server-provided trust-annotations (and fides-gateway labels) and action-metadata are then applied:
 * - Claims that make the label stricter are always accepted.
 * - Claims that relax it are accepted only from servers with
 *   `acceptServerClaims: true`, and never override an explicit config rule.
 *
 * The MCP spec says annotations from untrusted servers must not be trusted,
 * which is why relaxing claims need an explicit allowlist.
 */
import { destinationEgress, readActionMetadata, sensitivityConfidentiality, sourceIntegrity } from "./actionMetadata.js";
import type { AdtlConfig, Egress, ToolRule } from "./config.js";
import { higherConfidentiality, lowerIntegrity, type Confidentiality, type Integrity, type Label } from "./label.js";
import { readFidesClaims } from "./fides.js";
import { readClaims, unionClaims } from "./trustAnnotations.js";

export interface LabelInput {
  server: string;
  /** Tool name, for tools/call results. */
  tool?: string;
  /** Resource URI, for resources/read results. */
  resource?: string;
  /** Prompt name, for prompts/get results. */
  prompt?: string;
  /** The raw result returned by the upstream server. */
  result: unknown;
  /** MCP tool annotations from tools/list, if known (hints and the action-metadata extension). */
  toolAnnotations?: { openWorldHint?: boolean; [key: string]: unknown };
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

  const mayRelax = server?.acceptServerClaims === true;
  const meta = readActionMetadata(input.toolAnnotations);
  const metaIntegrity = sourceIntegrity(meta.source);
  const metaConfidentiality = sensitivityConfidentiality(meta.returnSensitivity);

  let integrity: Integrity =
    configuredIntegrity ??
    (metaIntegrity !== undefined && mayRelax
      ? metaIntegrity
      : input.toolAnnotations?.openWorldHint === true
        ? "untrusted"
        : config.defaults.integrity);
  let confidentiality: Confidentiality =
    configuredConfidentiality ?? (metaConfidentiality !== undefined && mayRelax ? metaConfidentiality : config.defaults.confidentiality);
  // action-metadata claims may always make the label stricter.
  if (metaIntegrity !== undefined) integrity = lowerIntegrity(integrity, metaIntegrity);
  if (metaConfidentiality !== undefined) confidentiality = higherConfidentiality(confidentiality, metaConfidentiality);

  // fides-gateway labels count like trust-annotations: the server's own claims.
  const fides = readFidesClaims(input.result);
  const claims = fides ? unionClaims(readClaims(input.result), fides) : readClaims(input.result);

  if (claims.untrusted === true) integrity = "untrusted";
  else if (claims.untrusted === false && mayRelax && configuredIntegrity === undefined) integrity = "trusted";

  if (claims.sensitive === true) confidentiality = higherConfidentiality(confidentiality, "private");
  else if (claims.sensitive === false && mayRelax && configuredConfidentiality === undefined) confidentiality = "public";

  const origin: Label["origins"][number] = { server: input.server };
  if (input.tool !== undefined) origin.tool = input.tool;
  if (input.resource !== undefined) origin.resource = input.resource;
  if (input.prompt !== undefined) origin.prompt = input.prompt;

  return { integrity, confidentiality, origins: [origin] };
}

const EGRESS_RANK: Partial<Record<Egress, number>> = { none: 0, internal: 1, external: 2, public: 3 };

/**
 * Where a tool can send data. Unconfigured tools are "unknown", unless the
 * tool's action-metadata names a destination: an allowlisted server's claim
 * is used as is, and any server's claim of external or public egress is
 * accepted, as is one stricter than the configured egress.
 */
export function toolEgress(config: AdtlConfig, server: string, tool: string, toolAnnotations?: unknown): Egress {
  const configured = toolRule(config, server, tool)?.egress ?? config.servers[server]?.defaults?.egress;
  const claimed = destinationEgress(readActionMetadata(toolAnnotations).destination);
  if (claimed === undefined) return configured ?? "unknown";
  if (configured === undefined || configured === "unknown") {
    const mayRelax = config.servers[server]?.acceptServerClaims === true;
    return mayRelax || EGRESS_RANK[claimed]! >= EGRESS_RANK.external! ? claimed : (configured ?? "unknown");
  }
  return EGRESS_RANK[claimed]! > EGRESS_RANK[configured]! ? claimed : configured;
}
