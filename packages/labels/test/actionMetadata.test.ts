import { describe, expect, it } from "vitest";
import {
  ACTION_METADATA_KEY,
  REQUIRES_REVIEW_RULE,
  evaluatePolicy,
  labelResult,
  parseConfig,
  readActionMetadata,
  toolEgress,
  type Label,
} from "../src/index.js";

const meta = (v: Record<string, unknown>) => ({ [ACTION_METADATA_KEY]: v });

const config = parseConfig({
  defaults: { integrity: "unknown", confidentiality: "public" },
  servers: {
    vault: { acceptServerClaims: true },
    stranger: {},
    mail: { tools: { send: { egress: "internal" }, draft: { integrity: "trusted", confidentiality: "public" } } },
  },
});

describe("readActionMetadata", () => {
  it("reads the draft fields and ignores malformed ones", () => {
    expect(
      readActionMetadata(
        meta({
          inputMetadata: { destination: "External", sensitivity: "personal" },
          returnMetadata: { source: "open-world", sensitivity: 3 },
          outcome: "irreversible",
          requiresReview: "yes",
        }),
      ),
    ).toEqual({ destination: "external", inputSensitivity: "personal", source: "open-world", outcome: "irreversible" });
    expect(readActionMetadata(undefined)).toEqual({});
    expect(readActionMetadata({ [ACTION_METADATA_KEY]: [] })).toEqual({});
  });
});

describe("labelResult with action-metadata", () => {
  const label = (server: string, tool: string, returnMetadata: Record<string, unknown>) =>
    labelResult({ server, tool, result: {}, toolAnnotations: meta({ returnMetadata }) }, config);

  it("accepts stricter claims from any server", () => {
    expect(label("stranger", "read", { source: "open-world", sensitivity: "personal" })).toMatchObject({
      integrity: "untrusted",
      confidentiality: "private",
    });
    expect(label("stranger", "read", { sensitivity: "credentials" }).confidentiality).toBe("secret");
    // Even over the owner's rule: a claim can only make a label stricter.
    expect(label("mail", "draft", { source: "open-world" }).integrity).toBe("untrusted");
  });

  it("relaxes only for allowlisted servers, and never over the owner's rule", () => {
    expect(label("stranger", "read", { source: "first-party" }).integrity).toBe("unknown");
    expect(label("vault", "read", { source: "first-party" }).integrity).toBe("trusted");
    const strict = parseConfig({ servers: { vault: { acceptServerClaims: true, tools: { read: { confidentiality: "private" } } } } });
    const l = labelResult({ server: "vault", tool: "read", result: {}, toolAnnotations: meta({ returnMetadata: { sensitivity: "public" } }) }, strict);
    expect(l.confidentiality).toBe("private");
  });

  it("comes ahead of openWorldHint for allowlisted servers", () => {
    const l = labelResult(
      { server: "vault", tool: "read", result: {}, toolAnnotations: { openWorldHint: true, ...meta({ returnMetadata: { source: "first-party" } }) } },
      config,
    );
    expect(l.integrity).toBe("trusted");
  });
});

describe("toolEgress with action-metadata", () => {
  const egress = (server: string, tool: string, destination: string) =>
    toolEgress(config, server, tool, meta({ inputMetadata: { destination } }));

  it("takes an allowlisted server's destination, and any server's external or public one", () => {
    expect(egress("vault", "write", "local")).toBe("internal");
    expect(egress("stranger", "write", "local")).toBe("unknown");
    expect(egress("stranger", "write", "external")).toBe("external");
    expect(egress("stranger", "write", "somewhere-new")).toBe("unknown");
  });

  it("lets a claim make the configured egress stricter, never looser", () => {
    expect(egress("mail", "send", "public")).toBe("public");
    expect(egress("mail", "send", "none")).toBe("internal");
  });
});

describe("policy with action-metadata", () => {
  const session: Label = { integrity: "trusted", confidentiality: "public", origins: [] };
  const policy = parseConfig({
    policy: { rules: [{ name: "no-irreversible-after-untrusted", when: { "session.integrity": "untrusted", "tool.outcome": "irreversible" }, then: "block" }] },
  }).policy;

  it("matches tool.outcome, and never matches tools that declare none", () => {
    const tainted = { ...session, integrity: "untrusted" as const };
    expect(evaluatePolicy(policy, { session: tainted, server: "s", tool: "t", egress: "none", outcome: "irreversible" }).decision).toBe("block");
    expect(evaluatePolicy(policy, { session: tainted, server: "s", tool: "t", egress: "none" }).decision).toBe("allow");
  });

  it("asks before tools that require review, unless turned off or a rule blocks", () => {
    const d = evaluatePolicy(policy, { session, server: "s", tool: "t", egress: "none", requiresReview: true });
    expect(d).toMatchObject({ decision: "ask", matched: [REQUIRES_REVIEW_RULE] });
    expect(evaluatePolicy({ ...policy, honorRequiresReview: false }, { session, server: "s", tool: "t", egress: "none", requiresReview: true }).decision).toBe("allow");
    const tainted = { ...session, integrity: "untrusted" as const };
    expect(
      evaluatePolicy(policy, { session: tainted, server: "s", tool: "t", egress: "none", outcome: "irreversible", requiresReview: true }).decision,
    ).toBe("block");
  });

  it("matches tool.requiresReview, counting a missing flag as false", () => {
    const p = parseConfig({ policy: { rules: [{ name: "r", when: { "tool.requiresReview": false }, then: "block" }] } }).policy;
    expect(evaluatePolicy(p, { session, server: "s", tool: "t", egress: "none" }).decision).toBe("block");
  });
});
