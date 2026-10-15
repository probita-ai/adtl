/**
 * Codec for MCP's draft `trust-annotations` extension
 * (modelcontextprotocol/experimental-ext-tool-annotations, draft skeleton).
 *
 * Wire shape, under a result's or content block's `_meta`:
 *
 *   "io.modelcontextprotocol/trust-annotations": {
 *     "untrusted"?: boolean,
 *     "sensitive"?: boolean,
 *     "evidenceRef"?: { type, digest, canonicalization, schema?, ref? }
 *   }
 *
 * Draft rules we follow:
 * - An absent boolean means "no claim", never "false".
 * - A content-block annotation may refine but never weaken the result-level one.
 * - Unknown `evidenceRef.type` values must be safely ignorable.
 */
import { digest } from "./canonical.js";
import type { Label } from "./label.js";

export const TRUST_ANNOTATIONS_KEY = "io.modelcontextprotocol/trust-annotations";

/** ADTL's own `_meta` key carrying the full label (richer than the draft booleans). */
export const ADTL_LABEL_KEY = "adtl/label";

/** `evidenceRef.type` for an ADTL label record. */
export const ADTL_EVIDENCE_TYPE = "adtl.label.v1";

export interface EvidenceRef {
  type: string;
  digest: string;
  canonicalization: string;
  schema?: string;
  ref?: string;
}

export interface TrustAnnotations {
  untrusted?: boolean;
  sensitive?: boolean;
  evidenceRef?: EvidenceRef;
}

/** What a payload claims about itself. `undefined` = no claim made. */
export interface TrustClaims {
  untrusted?: boolean;
  sensitive?: boolean;
}

type Meta = Record<string, unknown>;

interface HasMeta {
  _meta?: Meta;
}

interface ResultLike extends HasMeta {
  content?: unknown[];
  [key: string]: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function readAnnotations(meta: unknown): TrustClaims {
  if (!isRecord(meta)) return {};
  const raw = meta[TRUST_ANNOTATIONS_KEY];
  if (!isRecord(raw)) return {};
  const claims: TrustClaims = {};
  if (typeof raw.untrusted === "boolean") claims.untrusted = raw.untrusted;
  if (typeof raw.sensitive === "boolean") claims.sensitive = raw.sensitive;
  return claims;
}

/** Combine two claims with union semantics: once true, stays true. */
function unionClaims(a: TrustClaims, b: TrustClaims): TrustClaims {
  const out: TrustClaims = {};
  for (const k of ["untrusted", "sensitive"] as const) {
    if (a[k] === true || b[k] === true) out[k] = true;
    else if (a[k] === false || b[k] === false) out[k] = false;
  }
  return out;
}

/** The blocks inside a result that may carry their own annotation. */
function blocksOf(result: Record<string, unknown>): unknown[] {
  const blocks: unknown[] = [];
  // tools/call: content[]; resources/read: contents[]; prompts/get: messages[].content
  if (Array.isArray(result.content)) blocks.push(...result.content);
  if (Array.isArray(result.contents)) blocks.push(...result.contents);
  if (Array.isArray(result.messages)) {
    for (const m of result.messages) if (isRecord(m)) blocks.push(m, m.content);
  }
  return blocks;
}

/**
 * Read the trust claims a result makes, combining the result-level annotation
 * with any block-level annotations (blocks can only add restrictions).
 */
export function readClaims(result: unknown): TrustClaims {
  if (!isRecord(result)) return {};
  let claims = readAnnotations(result._meta);
  for (const block of blocksOf(result)) {
    if (isRecord(block)) claims = unionClaims(claims, readAnnotations(block._meta));
  }
  return claims;
}

/** The draft's booleans for a label. ADTL always asserts both explicitly. */
export function labelToAnnotations(label: Label): TrustAnnotations {
  return {
    untrusted: label.integrity !== "trusted",
    sensitive: label.confidentiality !== "public",
    evidenceRef: {
      type: ADTL_EVIDENCE_TYPE,
      digest: digest(label),
      canonicalization: "jcs/rfc8785",
    },
  };
}

/**
 * Return a copy of `result` with the label attached under both the draft
 * trust-annotations key and ADTL's own key. Other `_meta` entries are kept.
 */
export function attachLabel<T extends ResultLike>(result: T, label: Label): T & { _meta: Meta } {
  return {
    ...result,
    _meta: {
      ...(result._meta ?? {}),
      [TRUST_ANNOTATIONS_KEY]: labelToAnnotations(label),
      [ADTL_LABEL_KEY]: label,
    },
  };
}
