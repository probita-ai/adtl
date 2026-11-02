import { describe, expect, it } from "vitest";
import {
  FIDES_EVIDENCE_TYPE,
  FIDES_LABELS_KEY,
  attachLabel,
  digest,
  fidesEvidenceRef,
  fidesLabels,
  labelResult,
  parseConfig,
  readFidesClaims,
  toFidesLabel,
  toFidesRecord,
  type Label,
} from "../src/index.js";

// Shapes as fides-gateway puts them on a result's or request's _meta: JSONPath -> { integrity, confidentiality: [readers] }.
const fides = (map: Record<string, unknown>) => ({ content: [], _meta: { [FIDES_LABELS_KEY]: map } });
const L = (integrity: Label["integrity"], confidentiality: Label["confidentiality"]): Label => ({ integrity, confidentiality, origins: [] });

describe("reading fides-gateway labels", () => {
  it("maps integrity, and treats any reader list without public as private", () => {
    expect(readFidesClaims(fides({ $: { integrity: "trusted", confidentiality: ["public"] } }))).toEqual({ untrusted: false, sensitive: false });
    expect(readFidesClaims(fides({ $: { integrity: "untrusted", confidentiality: ["alice", "bob"] } }))).toEqual({ untrusted: true, sensitive: true });
    // An empty reader set is the most confidential label, not "no claim".
    expect(readFidesClaims(fides({ $: { integrity: "trusted", confidentiality: [] } }))).toEqual({ untrusted: false, sensitive: true });
  });

  it("takes the strictest label of every path, and of content blocks", () => {
    const r = fides({
      $: { integrity: "trusted", confidentiality: ["public"] },
      "$['structuredContent']['body']": { integrity: "untrusted", confidentiality: ["public"] },
      "$['structuredContent']['email']": { integrity: "trusted", confidentiality: ["alice"] },
    });
    expect(readFidesClaims(r)).toEqual({ untrusted: true, sensitive: true });
    const block = { content: [{ type: "text", text: "x", _meta: { [FIDES_LABELS_KEY]: { $: { integrity: "untrusted", confidentiality: ["public"] } } } }] };
    expect(readFidesClaims(block)).toEqual({ untrusted: true, sensitive: false });
  });

  it("fails closed on malformed labels, and says nothing when there are none", () => {
    expect(readFidesClaims(fides({ $: { integrity: "trusted" } }))).toEqual({ untrusted: false, sensitive: true });
    expect(readFidesClaims(fides({ $: "L" }))).toEqual({ untrusted: true, sensitive: true });
    expect(readFidesClaims({ content: [], _meta: { [FIDES_LABELS_KEY]: "nope" } })).toEqual({ untrusted: true, sensitive: true });
    expect(readFidesClaims({ content: [] })).toBeUndefined();
    expect(readFidesClaims(fides({}))).toBeUndefined();
  });

  it("feeds result labels like trust-annotations: stricter always, looser only for allowlisted servers", () => {
    const config = parseConfig({
      defaults: { integrity: "trusted", confidentiality: "public" },
      servers: { work: {}, relaxed: { acceptServerClaims: true } },
    });
    const secret = fides({ $: { integrity: "untrusted", confidentiality: ["alice"] } });
    expect(labelResult({ server: "work", tool: "read_mail", result: secret }, config)).toMatchObject({ integrity: "untrusted", confidentiality: "private" });
    const strict = parseConfig({ servers: { work: {}, relaxed: { acceptServerClaims: true } } });
    const open = fides({ $: { integrity: "trusted", confidentiality: ["public"] } });
    expect(labelResult({ server: "work", tool: "t", result: open }, strict)).toMatchObject({ integrity: "untrusted", confidentiality: "private" });
    expect(labelResult({ server: "relaxed", tool: "t", result: open }, strict)).toMatchObject({ integrity: "trusted", confidentiality: "public" });
  });
});

describe("writing fides-gateway labels", () => {
  it("maps ADTL's three levels onto FIDES's two, with the given readers for private data", () => {
    expect(toFidesLabel(L("trusted", "public"))).toEqual({ integrity: "trusted", confidentiality: ["public"] });
    expect(toFidesLabel(L("unknown", "private"), ["bob", "alice", "bob"])).toEqual({ integrity: "untrusted", confidentiality: ["alice", "bob"] });
    expect(toFidesLabel(L("trusted", "secret"))).toEqual({ integrity: "trusted", confidentiality: [] });
    // "public" as a reader would mean everyone: never emit it for private data.
    expect(toFidesLabel(L("trusted", "private"), ["public", "alice"]).confidentiality).toEqual(["alice"]);
  });

  it("puts one \"$\" entry on results, which covers every path in fides-gateway", () => {
    const out = attachLabel({ content: [] }, L("untrusted", "private"), { fides: { readers: ["alice"] } });
    expect(out._meta[FIDES_LABELS_KEY]).toEqual({ $: { integrity: "untrusted", confidentiality: ["alice"] } });
    expect(attachLabel({ content: [] }, L("trusted", "public"))._meta).not.toHaveProperty(FIDES_LABELS_KEY);
    expect(fidesLabels(L("trusted", "public"))).toEqual({ $: { integrity: "trusted", confidentiality: ["public"] } });
  });

  it("round-trips: what ADTL writes reads back as the same label", () => {
    for (const label of [L("trusted", "public"), L("untrusted", "public"), L("trusted", "private"), L("untrusted", "secret")]) {
      const claims = readFidesClaims(attachLabel({ content: [] }, label, { fides: { readers: ["alice"] } }));
      expect(claims).toEqual({ untrusted: label.integrity !== "trusted", sensitive: label.confidentiality !== "public" });
    }
  });
});

describe("ifc.fides.v1 evidence", () => {
  it("builds the scheme record and an evidenceRef over its JCS digest", () => {
    expect(toFidesRecord(L("unknown", "secret"))).toEqual({ integrity: "untrusted", confidentiality: "private" });
    expect(fidesEvidenceRef(L("trusted", "public"))).toEqual({
      type: FIDES_EVIDENCE_TYPE,
      digest: digest({ integrity: "trusted", confidentiality: "public" }),
      canonicalization: "jcs/rfc8785",
    });
  });
});
