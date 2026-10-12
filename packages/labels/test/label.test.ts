import { describe, expect, it } from "vitest";
import { EMPTY_LABEL, MAX_ORIGINS, isAtLeastAsRestrictive, join, joinAll, type Label } from "../src/index.js";

const untrustedPublic: Label = { integrity: "untrusted", confidentiality: "public", origins: [{ server: "github", tool: "read_issue" }] };
const trustedPrivate: Label = { integrity: "trusted", confidentiality: "private", origins: [{ server: "github", tool: "get_file" }] };

describe("join", () => {
  it("takes the lowest integrity and highest confidentiality", () => {
    const j = join(untrustedPublic, trustedPrivate);
    expect(j.integrity).toBe("untrusted");
    expect(j.confidentiality).toBe("private");
  });

  it("treats unknown integrity as between untrusted and trusted", () => {
    const unknown: Label = { integrity: "unknown", confidentiality: "public", origins: [] };
    expect(join(unknown, trustedPrivate).integrity).toBe("unknown");
    expect(join(unknown, untrustedPublic).integrity).toBe("untrusted");
  });

  it("is commutative and idempotent", () => {
    expect(join(untrustedPublic, trustedPrivate)).toEqual({
      ...join(trustedPrivate, untrustedPublic),
      origins: expect.any(Array),
    });
    const once = join(untrustedPublic, trustedPrivate);
    expect(join(once, once)).toEqual(once);
  });

  it("deduplicates origins and caps their number", () => {
    expect(join(untrustedPublic, untrustedPublic).origins).toHaveLength(1);
    const many = Array.from({ length: MAX_ORIGINS + 10 }, (_, i): Label => ({
      integrity: "trusted",
      confidentiality: "public",
      origins: [{ server: "s", tool: `t${i}` }],
    }));
    const all = joinAll(many);
    expect(all.origins).toHaveLength(MAX_ORIGINS);
    expect(all.origins.at(-1)?.tool).toBe(`t${MAX_ORIGINS + 9}`);
  });

  it("never makes a label less restrictive", () => {
    const j = join(untrustedPublic, trustedPrivate);
    expect(isAtLeastAsRestrictive(j, untrustedPublic)).toBe(true);
    expect(isAtLeastAsRestrictive(j, trustedPrivate)).toBe(true);
    expect(isAtLeastAsRestrictive(EMPTY_LABEL, j)).toBe(false);
  });
});
