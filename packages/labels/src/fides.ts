/**
 * Interop with FIDES (Microsoft's information-flow-control model,
 * arXiv:2505.23643), in two wire forms:
 *
 * - fides-gateway's `_meta["com.github.ifc/labels"]`: a map from RFC 9535
 *   JSONPath strings ("$" = the whole payload) to
 *   `{ integrity: "trusted" | "untrusted", confidentiality: [readers] }`,
 *   where `["public"]` means everyone and fewer readers is more confidential.
 *   It is used on tool results and on tool-call requests.
 * - The trust-annotations `ifc.fides.v1` scheme: an `evidenceRef` record
 *   `{ integrity: "trusted" | "untrusted", confidentiality: "public" | "private" }`.
 *
 * Mapping to ADTL: FIDES has two integrity levels, so ADTL's `unknown` is
 * `untrusted`; any reader list without "public" (even an empty one) is
 * `private`, and ADTL's `private` and `secret` both become a reader list.
 * ADTL has no reader sets, so it emits the readers the caller passes
 * (e.g. the user running the gateway), or none, which FIDES reads as the most
 * confidential label.
 */
import { digest } from "./canonical.js";
import type { Label } from "./label.js";
import type { EvidenceRef, TrustClaims } from "./trustAnnotations.js";

export const FIDES_LABELS_KEY = "com.github.ifc/labels";
export const FIDES_EVIDENCE_TYPE = "ifc.fides.v1";
/** fides-gateway's reader-set sentinel for "everyone". */
export const FIDES_PUBLIC = "public";

export interface FidesLabel {
  integrity: "trusted" | "untrusted";
  confidentiality: string[];
}

export interface FidesRecord {
  integrity: "trusted" | "untrusted";
  confidentiality: "public" | "private";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One fides-gateway label as trust claims. A malformed label claims the worst. */
function claimsOf(v: unknown): TrustClaims {
  if (!isRecord(v)) return { untrusted: true, sensitive: true };
  const conf = Array.isArray(v.confidentiality) ? v.confidentiality : undefined;
  return {
    untrusted: v.integrity !== "trusted",
    sensitive: conf === undefined || !conf.includes(FIDES_PUBLIC),
  };
}

function readMap(meta: unknown): TrustClaims | undefined {
  if (!isRecord(meta) || !(FIDES_LABELS_KEY in meta)) return undefined;
  const map = meta[FIDES_LABELS_KEY];
  if (!isRecord(map)) return { untrusted: true, sensitive: true };
  const entries = Object.values(map);
  if (entries.length === 0) return undefined;
  // ADTL labels the whole result, so take the strictest label of any path.
  return entries.map(claimsOf).reduce((a, b) => ({ untrusted: a.untrusted || b.untrusted, sensitive: a.sensitive || b.sensitive }));
}

/**
 * The trust claims fides-gateway labels on a result make: the strictest of
 * every path, on the result and on its content blocks. Undefined when there are none.
 */
export function readFidesClaims(result: unknown): TrustClaims | undefined {
  if (!isRecord(result)) return undefined;
  const found = [readMap(result._meta)];
  for (const key of ["content", "contents"]) {
    const blocks = result[key];
    if (Array.isArray(blocks)) for (const b of blocks) if (isRecord(b)) found.push(readMap(b._meta));
  }
  const claims = found.filter((c): c is TrustClaims => c !== undefined);
  if (claims.length === 0) return undefined;
  return claims.reduce((a, b) => ({ untrusted: a.untrusted === true || b.untrusted === true, sensitive: a.sensitive === true || b.sensitive === true }));
}

/** An ADTL label as a fides-gateway label. `readers` are who may read private data. */
export function toFidesLabel(label: Label, readers: readonly string[] = []): FidesLabel {
  return {
    integrity: label.integrity === "trusted" ? "trusted" : "untrusted",
    confidentiality: label.confidentiality === "public" ? [FIDES_PUBLIC] : [...new Set(readers)].filter((r) => r !== FIDES_PUBLIC).sort(),
  };
}

/** The `_meta` entry fides-gateway reads: the label for the whole payload ("$"). */
export function fidesLabels(label: Label, readers: readonly string[] = []): Record<string, FidesLabel> {
  return { $: toFidesLabel(label, readers) };
}

/** The trust-annotations `ifc.fides.v1` scheme record for a label. */
export function toFidesRecord(label: Label): FidesRecord {
  return {
    integrity: label.integrity === "trusted" ? "trusted" : "untrusted",
    confidentiality: label.confidentiality === "public" ? "public" : "private",
  };
}

/** An `evidenceRef` pointing at the `ifc.fides.v1` record of a label. */
export function fidesEvidenceRef(label: Label): EvidenceRef {
  return { type: FIDES_EVIDENCE_TYPE, digest: digest(toFidesRecord(label)), canonicalization: "jcs/rfc8785" };
}
