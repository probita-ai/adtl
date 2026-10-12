import { describe, expect, it } from "vitest";
import {
  InMemorySessionStore,
  evaluatePolicy,
  labelResult,
  parseConfig,
  toolEgress,
  type Label,
} from "../src/index.js";

const config = parseConfig({
  servers: {
    github: {
      tools: {
        read_issue: { integrity: "untrusted", confidentiality: "public" },
        get_file: { integrity: "trusted", confidentiality: "private" },
        post_comment: { egress: "public" },
        list_repos: { integrity: "trusted", confidentiality: "public", egress: "none" },
      },
    },
  },
  policy: {
    default: "allow",
    rules: [
      {
        name: "no-public-write-after-untrusted",
        when: { "session.integrity": "untrusted", "tool.egress": ["public", "external", "unknown"] },
        then: "ask",
      },
      {
        name: "private-stays-private",
        when: { "session.confidentiality": ["private", "secret"], "tool.egress": "public" },
        then: "block",
        reason: "Private data must not reach a public tool",
      },
    ],
  },
});

const label = (integrity: Label["integrity"], confidentiality: Label["confidentiality"]): Label => ({
  integrity,
  confidentiality,
  origins: [],
});

describe("evaluatePolicy", () => {
  it("uses the default when nothing matches", () => {
    const d = evaluatePolicy(config.policy, { session: label("trusted", "public"), server: "github", tool: "post_comment", egress: "public" });
    expect(d).toMatchObject({ decision: "allow", matched: [] });
  });

  it("picks the most restrictive matching decision regardless of rule order", () => {
    const d = evaluatePolicy(config.policy, { session: label("untrusted", "private"), server: "github", tool: "post_comment", egress: "public" });
    expect(d.decision).toBe("block");
    expect(d.matched).toEqual(["private-stays-private"]);
    expect(d.reason).toBe("Private data must not reach a public tool");

    const reversed = { ...config.policy, rules: [...config.policy.rules].reverse() };
    expect(evaluatePolicy(reversed, { session: label("untrusted", "private"), server: "github", tool: "post_comment", egress: "public" }).decision).toBe("block");
  });

  it("matches tool globs against server.tool", () => {
    const policy = parseConfig({ policy: { rules: [{ name: "gh", when: { tool: "github.*" }, then: "ask" }] } }).policy;
    expect(evaluatePolicy(policy, { session: label("trusted", "public"), server: "github", tool: "x", egress: "none" }).decision).toBe("ask");
    expect(evaluatePolicy(policy, { session: label("trusted", "public"), server: "gitlab", tool: "x", egress: "none" }).decision).toBe("allow");
  });

  it("does not treat glob metacharacters other than * as wildcards", () => {
    const policy = parseConfig({ policy: { rules: [{ name: "dot", when: { tool: "a.b" }, then: "block" }] } }).policy;
    expect(evaluatePolicy(policy, { session: label("trusted", "public"), server: "a", tool: "b", egress: "none" }).decision).toBe("block");
    expect(evaluatePolicy(policy, { session: label("trusted", "public"), server: "aXb", tool: "", egress: "none" }).decision).toBe("allow");
  });
});

describe("scenario: GitHub issue exfiltration (Invariant Labs, 2025)", () => {
  // An attacker's public issue tells the agent to copy a private file into a public comment.
  const sessions = new InMemorySessionStore();
  const sid = "session-1";

  const decide = (tool: string) =>
    evaluatePolicy(config.policy, {
      session: sessions.get(sid),
      server: "github",
      tool,
      egress: toolEgress(config, "github", tool),
    });

  it("allows the public comment before the session has seen anything", () => {
    expect(decide("post_comment").decision).toBe("allow");
  });

  it("asks once the attacker's issue has been read", () => {
    sessions.observe(sid, labelResult({ server: "github", tool: "read_issue", result: { content: [] } }, config));
    expect(sessions.get(sid).integrity).toBe("untrusted");
    expect(decide("post_comment").decision).toBe("ask");
  });

  it("blocks the leak once private data is also in context", () => {
    sessions.observe(sid, labelResult({ server: "github", tool: "get_file", result: { content: [] } }, config));
    expect(sessions.get(sid)).toMatchObject({ integrity: "untrusted", confidentiality: "private" });
    expect(decide("post_comment")).toMatchObject({ decision: "block", matched: ["private-stays-private"] });
  });

  it("still allows harmless tools with no egress", () => {
    expect(decide("list_repos").decision).toBe("allow");
  });

  it("keeps sessions isolated and resettable", () => {
    expect(sessions.get("other").integrity).toBe("trusted");
    sessions.reset(sid);
    expect(decide("post_comment").decision).toBe("allow");
  });
});
