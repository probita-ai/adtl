import { describe, expect, it } from "vitest";
import { TRUST_ANNOTATIONS_KEY, labelResult, parseConfig, toolEgress } from "../src/index.js";

const config = parseConfig({
  servers: {
    github: {
      tools: {
        read_issue: { integrity: "untrusted", confidentiality: "public" },
        get_file: { integrity: "trusted", confidentiality: "private" },
        post_comment: { egress: "public" },
      },
    },
    vault: { acceptServerClaims: true },
    stranger: { acceptServerClaims: false },
    docs: { defaults: { integrity: "trusted", confidentiality: "public", egress: "none" } },
  },
});

const withClaims = (v: Record<string, unknown>) => ({ content: [], _meta: { [TRUST_ANNOTATIONS_KEY]: v } });

describe("labelResult", () => {
  it("uses the tool rule from config", () => {
    const l = labelResult({ server: "github", tool: "read_issue", result: { content: [] } }, config);
    expect(l).toEqual({ integrity: "untrusted", confidentiality: "public", origins: [{ server: "github", tool: "read_issue" }] });
  });

  it("falls back to server defaults, then global defaults", () => {
    expect(labelResult({ server: "docs", tool: "search", result: {} }, config)).toMatchObject({
      integrity: "trusted",
      confidentiality: "public",
    });
    expect(labelResult({ server: "unknown-server", tool: "x", result: {} }, config)).toMatchObject({
      integrity: "untrusted",
      confidentiality: "private",
    });
  });

  it("treats open-world tools as untrusted when config is silent", () => {
    const relaxed = parseConfig({ defaults: { integrity: "trusted", confidentiality: "public" } });
    const l = labelResult({ server: "web", tool: "fetch", result: {}, toolAnnotations: { openWorldHint: true } }, relaxed);
    expect(l.integrity).toBe("untrusted");
  });

  it("always accepts stricter claims, even from non-allowlisted servers", () => {
    const l = labelResult({ server: "github", tool: "get_file", result: withClaims({ untrusted: true, sensitive: true }) }, config);
    expect(l.integrity).toBe("untrusted");
    expect(l.confidentiality).toBe("private");
  });

  it("ignores relaxing claims from servers that are not allowlisted", () => {
    const l = labelResult({ server: "stranger", tool: "x", result: withClaims({ untrusted: false, sensitive: false }) }, config);
    expect(l).toMatchObject({ integrity: "untrusted", confidentiality: "private" });
  });

  it("accepts relaxing claims from allowlisted servers", () => {
    const l = labelResult({ server: "vault", tool: "x", result: withClaims({ untrusted: false, sensitive: false }) }, config);
    expect(l).toMatchObject({ integrity: "trusted", confidentiality: "public" });
  });

  it("never lets a server relax an explicit config rule", () => {
    const strict = parseConfig({
      servers: { vault: { acceptServerClaims: true, tools: { read: { integrity: "untrusted", confidentiality: "secret" } } } },
    });
    const l = labelResult({ server: "vault", tool: "read", result: withClaims({ untrusted: false, sensitive: false }) }, strict);
    expect(l).toMatchObject({ integrity: "untrusted", confidentiality: "secret" });
  });

  it("records the resource URI for resource reads", () => {
    const l = labelResult({ server: "docs", resource: "file:///a.md", result: {} }, config);
    expect(l.origins).toEqual([{ server: "docs", resource: "file:///a.md" }]);
  });
});

describe("toolEgress", () => {
  it("reads the tool rule, then server defaults, else unknown", () => {
    expect(toolEgress(config, "github", "post_comment")).toBe("public");
    expect(toolEgress(config, "docs", "anything")).toBe("none");
    expect(toolEgress(config, "github", "read_issue")).toBe("unknown");
  });
});

describe("parseConfig", () => {
  it("fills restrictive defaults", () => {
    const c = parseConfig(undefined);
    expect(c.defaults).toEqual({ integrity: "untrusted", confidentiality: "private" });
    expect(c.policy).toEqual({ default: "allow", rules: [] });
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parseConfig({ servers: { a: { tools: { t: { integrity: "maybe" } } } } })).toThrow();
    expect(() => parseConfig({ serverz: {} })).toThrow();
  });
});
