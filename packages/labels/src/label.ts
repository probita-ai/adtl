/**
 * Core label model.
 *
 * A label has two security axes plus provenance:
 * - integrity: can this data be trusted to influence actions?
 * - confidentiality: who may see it?
 * - origins: where it came from (for audit and policy).
 *
 * Labels form a lattice. Combining data takes the *lowest* integrity and the
 * *highest* confidentiality of its inputs, so a label can only ever get more
 * restrictive as data flows (unless a human explicitly declassifies it).
 */

/** Ordered from least to most trusted. "unknown" sits between the two. */
export const INTEGRITY_LEVELS = ["untrusted", "unknown", "trusted"] as const;
export type Integrity = (typeof INTEGRITY_LEVELS)[number];

/** Ordered from least to most restricted. */
export const CONFIDENTIALITY_LEVELS = ["public", "private", "secret"] as const;
export type Confidentiality = (typeof CONFIDENTIALITY_LEVELS)[number];

export interface Origin {
  /** Upstream MCP server id, as named in the gateway config. */
  server: string;
  /** Tool name, for tools/call results. */
  tool?: string;
  /** Resource URI, for resources/read results. */
  resource?: string;
  /** Prompt name, for prompts/get results. */
  prompt?: string;
}

export interface Label {
  integrity: Integrity;
  confidentiality: Confidentiality;
  origins: Origin[];
}

/** The label of a session that has seen nothing yet. */
export const EMPTY_LABEL: Readonly<Label> = Object.freeze({
  integrity: "trusted",
  confidentiality: "public",
  origins: [],
});

/** Upper bound on stored origins so long sessions don't grow without limit. */
export const MAX_ORIGINS = 64;

function integrityRank(i: Integrity): number {
  return INTEGRITY_LEVELS.indexOf(i);
}

function confidentialityRank(c: Confidentiality): number {
  return CONFIDENTIALITY_LEVELS.indexOf(c);
}

export function lowerIntegrity(a: Integrity, b: Integrity): Integrity {
  return integrityRank(a) <= integrityRank(b) ? a : b;
}

export function higherConfidentiality(a: Confidentiality, b: Confidentiality): Confidentiality {
  return confidentialityRank(a) >= confidentialityRank(b) ? a : b;
}

function originKey(o: Origin): string {
  return `${o.server}\u0000${o.tool ?? ""}\u0000${o.resource ?? ""}\u0000${o.prompt ?? ""}`;
}

export function mergeOrigins(a: readonly Origin[], b: readonly Origin[]): Origin[] {
  const seen = new Set<string>();
  const out: Origin[] = [];
  for (const o of [...a, ...b]) {
    const k = originKey(o);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...o });
  }
  // Keep the most recent origins when over the cap.
  return out.length > MAX_ORIGINS ? out.slice(out.length - MAX_ORIGINS) : out;
}

/** Combine two labels: lowest integrity, highest confidentiality, union of origins. */
export function join(a: Label, b: Label): Label {
  return {
    integrity: lowerIntegrity(a.integrity, b.integrity),
    confidentiality: higherConfidentiality(a.confidentiality, b.confidentiality),
    origins: mergeOrigins(a.origins, b.origins),
  };
}

export function joinAll(labels: Iterable<Label>): Label {
  let acc: Label = { ...EMPTY_LABEL, origins: [] };
  for (const l of labels) acc = join(acc, l);
  return acc;
}

/** True if `a` is at least as restrictive as `b` on both axes. */
export function isAtLeastAsRestrictive(a: Label, b: Label): boolean {
  return (
    integrityRank(a.integrity) <= integrityRank(b.integrity) &&
    confidentialityRank(a.confidentiality) >= confidentialityRank(b.confidentiality)
  );
}
