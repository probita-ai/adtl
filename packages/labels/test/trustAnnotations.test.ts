import { describe, expect, it } from "vitest";
import {
  ADTL_EVIDENCE_TYPE,
  ADTL_LABEL_KEY,
  TRUST_ANNOTATIONS_KEY,
  attachLabel,
  digest,
  readClaims,
  type Label,
} from "../src/index.js";

const ann = (v: Record<string, unknown>) => ({ [TRUST_ANNOTATIONS_KEY]: v });

describe("readClaims", () => {
  it("returns no claims when the annotation is absent", () => {
    expect(readClaims({ content: [{ type: "text", text: "hi" }] })).toEqual({});
    expect(readClaims(null)).toEqual({});
  });

  it("reads result-level booleans and ignores other types", () => {
    expect(readClaims({ _meta: ann({ untrusted: true, sensitive: "yes" }) })).toEqual({ untrusted: true });
  });

  it("lets content blocks add restrictions but never remove them", () => {
    const result = {
      _meta: ann({ untrusted: true, sensitive: false }),
      content: [
        { type: "text", text: "a", _meta: ann({ untrusted: false }) },
        { type: "text", text: "b", _meta: ann({ sensitive: true }) },
      ],
    };
    expect(readClaims(result)).toEqual({ untrusted: true, sensitive: true });
  });

  it("reads block annotations in resource contents and prompt messages", () => {
    expect(readClaims({ contents: [{ uri: "a", text: "x", _meta: ann({ untrusted: true }) }] })).toEqual({ untrusted: true });
    expect(
      readClaims({ messages: [{ role: "user", content: { type: "text", text: "x", _meta: ann({ sensitive: true }) } }] }),
    ).toEqual({ sensitive: true });
  });

  it("ignores unknown evidenceRef types", () => {
    const result = { _meta: ann({ untrusted: false, evidenceRef: { type: "x.unknown.v9", digest: "sha256:00" } }) };
    expect(readClaims(result)).toEqual({ untrusted: false });
  });
});

describe("attachLabel", () => {
  const label: Label = { integrity: "untrusted", confidentiality: "private", origins: [{ server: "gmail", tool: "read" }] };

  it("writes the draft booleans, an evidenceRef, and the full ADTL label", () => {
    const out = attachLabel({ content: [], _meta: { other: 1 } }, label);
    expect(out._meta?.other).toBe(1);
    expect(out._meta?.[TRUST_ANNOTATIONS_KEY]).toEqual({
      untrusted: true,
      sensitive: true,
      evidenceRef: { type: ADTL_EVIDENCE_TYPE, digest: digest(label), canonicalization: "jcs/rfc8785" },
    });
    expect(out._meta?.[ADTL_LABEL_KEY]).toEqual(label);
  });

  it("asserts explicit false for trusted public data", () => {
    const out = attachLabel({ content: [] }, { integrity: "trusted", confidentiality: "public", origins: [] });
    expect(readClaims(out)).toEqual({ untrusted: false, sensitive: false });
  });

  it("does not mutate the input", () => {
    const input = { content: [] as unknown[] };
    attachLabel(input, label);
    expect(input).toEqual({ content: [] });
  });
});
