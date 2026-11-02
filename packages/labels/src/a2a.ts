/**
 * Trust labels on A2A (Agent2Agent) messages and artifacts: the ADTL A2A
 * extension, draft v1 (docs/a2a-trust-labels-v1.md).
 *
 * The sending agent's gateway puts its session label on each Message or
 * Artifact it sends, under `metadata[A2A_TRUST_LABELS_URI]`, signed with its
 * Ed25519 key and bound to the object's parts by their digest:
 *
 *   "metadata": {
 *     "<A2A_TRUST_LABELS_URI>": {
 *       "label": { "integrity", "confidentiality", "origins" },
 *       "partsDigest": "sha256:…",       // JCS over `parts`
 *       "issuedAt": "2026-11-01T…Z",
 *       "signer": "ed25519:…",
 *       "signature": "…"                 // over JCS of the four fields above (+ messageId / artifactId)
 *     }
 *   }
 *
 * The receiver joins the label into what it already assumes about that agent:
 * a label signed by a key it trusts is used as is; one signed by another key
 * can only make things stricter; a missing, malformed or broken one leaves the
 * receiver's own (restrictive by default) label for that agent.
 */
import { digest } from "./canonical.js";
import { CONFIDENTIALITY_LEVELS, INTEGRITY_LEVELS, join, type Label } from "./label.js";
import { signCanonical, verifyCanonical, type Signer } from "./signing.js";

export const A2A_TRUST_LABELS_URI = "https://github.com/probita-ai/adtl/blob/main/docs/a2a-trust-labels-v1.md";

export interface A2ATrustLabel {
  label: Label;
  partsDigest: string;
  issuedAt: string;
  signer: string;
  signature: string;
}

/** The parts of A2A Message and Artifact objects this extension reads and writes. */
export interface A2AObject {
  parts?: unknown[];
  metadata?: Record<string, unknown>;
  messageId?: string;
  artifactId?: string;
  extensions?: string[];
  [key: string]: unknown;
}

export type A2ALabelStatus = "verified" | "untrusted-signer" | "invalid" | "missing";

export interface A2AReadResult {
  /** The label to use for this object. */
  label: Label;
  status: A2ALabelStatus;
  /** Why the label was not used as is. */
  reason?: string;
  signer?: string;
}

export interface A2AReadOptions {
  /** Public keys (`ed25519:…`) of senders whose labels may relax `fallback`. */
  trustedKeys?: readonly string[];
  /** What to assume about this sender without a usable label. Default: untrusted, private. */
  fallback?: Label;
}

const RESTRICTIVE: Label = { integrity: "untrusted", confidentiality: "private", origins: [] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function signedFields(obj: A2AObject, t: Omit<A2ATrustLabel, "signature">): Record<string, unknown> {
  return {
    ...t,
    ...(obj.messageId !== undefined ? { messageId: obj.messageId } : {}),
    ...(obj.artifactId !== undefined ? { artifactId: obj.artifactId } : {}),
  };
}

/**
 * Return a copy of an A2A Message or Artifact with `label` attached and
 * signed. A Message also lists the extension in `extensions`.
 */
export function signA2ALabel<T extends A2AObject>(obj: T, label: Label, signer: Signer, now: Date = new Date()): T {
  const unsigned = { label, partsDigest: digest(obj.parts ?? []), issuedAt: now.toISOString(), signer: signer.publicKey };
  const entry: A2ATrustLabel = { ...unsigned, signature: signCanonical(signer, signedFields(obj, unsigned)) };
  const extensions = obj.messageId !== undefined ? { extensions: [...new Set([...(obj.extensions ?? []), A2A_TRUST_LABELS_URI])] } : {};
  return { ...obj, ...extensions, metadata: { ...(obj.metadata ?? {}), [A2A_TRUST_LABELS_URI]: entry } };
}

function parseLabel(v: unknown): Label | undefined {
  if (!isRecord(v)) return undefined;
  if (!INTEGRITY_LEVELS.includes(v.integrity as never) || !CONFIDENTIALITY_LEVELS.includes(v.confidentiality as never)) return undefined;
  if (!Array.isArray(v.origins) || !v.origins.every((o) => isRecord(o) && typeof o.server === "string")) return undefined;
  return v as unknown as Label;
}

/** Read and check the label on a received A2A Message or Artifact. */
export function readA2ALabel(obj: A2AObject, opts: A2AReadOptions = {}): A2AReadResult {
  const fallback = opts.fallback ?? RESTRICTIVE;
  const raw = isRecord(obj.metadata) ? obj.metadata[A2A_TRUST_LABELS_URI] : undefined;
  if (raw === undefined) return { label: fallback, status: "missing" };
  const fail = (reason: string, signer?: string): A2AReadResult => ({ label: join(fallback, RESTRICTIVE), status: "invalid", reason, ...(signer ? { signer } : {}) });
  if (!isRecord(raw)) return fail("label entry is not an object");
  const label = parseLabel(raw.label);
  const { partsDigest, issuedAt, signer, signature } = raw;
  if (!label || typeof partsDigest !== "string" || typeof issuedAt !== "string" || typeof signer !== "string" || typeof signature !== "string") {
    return fail("label entry is malformed");
  }
  if (partsDigest !== digest(obj.parts ?? [])) return fail("parts changed after the label was signed", signer);
  let valid = false;
  try {
    valid = verifyCanonical(signer, signedFields(obj, { label, partsDigest, issuedAt, signer }), signature);
  } catch {
    valid = false;
  }
  if (!valid) return fail("signature does not verify", signer);
  if (opts.trustedKeys?.includes(signer)) return { label, status: "verified", signer };
  return { label: join(fallback, label), status: "untrusted-signer", reason: "signed by a key that is not trusted: the label can only make things stricter", signer };
}
