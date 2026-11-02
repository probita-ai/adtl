/**
 * Reader for the Tool Annotations IG's draft `action-metadata` extension
 * (modelcontextprotocol/experimental-ext-tool-annotations,
 * specification/draft/action-metadata.mdx), carried on a tool's annotations:
 *
 *   "io.modelcontextprotocol/action-metadata": {
 *     "inputMetadata":  { "destination"?: string, "sensitivity"?: string },
 *     "returnMetadata": { "source"?: string, "sensitivity"?: string },
 *     "outcome"?: "benign" | "consequential" | "irreversible",
 *     "requiresReview"?: boolean
 *   }
 *
 * These are the server's own claims. Callers use them only to make a label
 * or an egress stricter, unless the server is allowlisted. The value sets are
 * still open upstream, so unknown values map to the cautious choice or to
 * no claim.
 */
import type { Egress } from "./config.js";
import type { Confidentiality, Integrity } from "./label.js";

export const ACTION_METADATA_KEY = "io.modelcontextprotocol/action-metadata";

export interface ActionMetadata {
  destination?: string;
  inputSensitivity?: string;
  source?: string;
  returnSensitivity?: string;
  outcome?: string;
  requiresReview?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v.toLowerCase() : undefined);

/** Read action-metadata from a tool's annotations. Malformed fields are ignored. */
export function readActionMetadata(annotations: unknown): ActionMetadata {
  if (!isRecord(annotations)) return {};
  const raw = annotations[ACTION_METADATA_KEY];
  if (!isRecord(raw)) return {};
  const input = isRecord(raw.inputMetadata) ? raw.inputMetadata : {};
  const ret = isRecord(raw.returnMetadata) ? raw.returnMetadata : {};
  const out: ActionMetadata = {};
  const set = <K extends keyof ActionMetadata>(k: K, v: ActionMetadata[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("destination", str(input.destination));
  set("inputSensitivity", str(input.sensitivity));
  set("source", str(ret.source));
  set("returnSensitivity", str(ret.sensitivity));
  set("outcome", str(raw.outcome));
  if (typeof raw.requiresReview === "boolean") out.requiresReview = raw.requiresReview;
  return out;
}

/** `inputMetadata.destination` as an ADTL egress, or undefined for values we don't know. */
export function destinationEgress(destination: string | undefined): Egress | undefined {
  switch (destination) {
    case "none":
      return "none";
    case "local":
    case "internal":
      return "internal";
    case "external":
      return "external";
    case "public":
      return "public";
    default:
      return undefined;
  }
}

/** `returnMetadata.source` as an integrity: `open-world` is untrusted, `first-party` trusted. */
export function sourceIntegrity(source: string | undefined): Integrity | undefined {
  if (source === "open-world") return "untrusted";
  if (source === "first-party") return "trusted";
  return undefined;
}

/** `returnMetadata.sensitivity` as a confidentiality. Any value other than `public` is at least private. */
export function sensitivityConfidentiality(sensitivity: string | undefined): Confidentiality | undefined {
  if (sensitivity === undefined) return undefined;
  if (sensitivity === "public") return "public";
  if (["secret", "credentials", "credential", "secrets"].includes(sensitivity)) return "secret";
  return "private";
}
