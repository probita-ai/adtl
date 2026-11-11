import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSessionStore,
  InMemorySessionStore,
  evaluatePolicy,
  isSecretLike,
  parseConfig,
  secretFingerprints,
  secretLikeTokens,
  usesCopiesPrivate,
  valueFingerprint,
  type Label,
  type SessionStore,
} from "../src/index.js";

describe("secret-like values", () => {
  it("counts tokens with letters and digits", () => {
    for (const t of ["ghp_Bc4dEf5gHi6jKl7mNo8pQr9s", "AKIA5MZXN8QRF3WBY6OE", "sk_live_4eC7aRm9Kx2bNw5pQj8sYd", "dGhpcyBpcyBhIHNlY3JldDEy=="]) {
      expect(isSecretLike(t), t).toBe(true);
    }
  });

  it("leaves out names, hex hashes, commit ids, UUIDs and short values", () => {
    for (const t of [
      "architecture_decisions",
      "onboarding_checklist",
      "242acaee52934fdbe0085185f72685ec8d422850",
      "800fe4271cd88cbe1eca6a291b6f6ddbfa88f5e9444c65efb519cf3c30f5b7ea",
      "3f2a9c1e-8b7d-4e6f-a5c4-1b2d3e4f5a6b",
      "abc123",
    ]) {
      expect(isSecretLike(t), t).toBe(false);
    }
  });

  it("splits KEY=value so the value matches on its own", () => {
    expect(secretLikeTokens("API_TOKEN=ghp_Xa2bC3dEf4gH5iJk6Lm7nN8oP\npath: /usr/local/lib/node_modules")).toEqual(["ghp_Xa2bC3dEf4gH5iJk6Lm7nN8oP"]);
  });

  it("skips folder names in paths, but not values inside URLs", () => {
    expect(secretLikeTokens("/mcphunt/workspace/deepseek_v4_flash/notes/plan.md")).toEqual([]);
    expect(secretLikeTokens("redis://rTk_7f8a9b0c1d2e3f4a5b6c@cache.internal/0")).toEqual(["rTk_7f8a9b0c1d2e3f4a5b6c"]);
    expect(secretLikeTokens("https://hooks.example.com/services/T04N7R/nK7mP9qR2sT4vW6xYz")).toEqual(["nK7mP9qR2sT4vW6xYz"]);
  });

  it("fingerprints every string inside a value, without keeping the value", () => {
    const prints = secretFingerprints({ a: ["x", { token: "Bearer ghp_Bc4dEf5gHi6jKl7mNo8pQr9s" }], n: 3 });
    expect(prints).toEqual([valueFingerprint("ghp_Bc4dEf5gHi6jKl7mNo8pQr9s")]);
    expect(prints[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(secretFingerprints({ body: "nothing secret here" })).toEqual([]);
  });
});

const stores: [string, () => SessionStore][] = [
  ["InMemorySessionStore", () => new InMemorySessionStore()],
  ["FileSessionStore", () => new FileSessionStore(mkdtempSync(join(tmpdir(), "adtl-values-")))],
];

describe.each(stores)("%s private values", (_, make) => {
  it("remembers fingerprints per session, and reset forgets them", () => {
    const s = make();
    const env = secretFingerprints("DB_PASSWORD=Pq7rT2vW9xYz4bCd6eF");
    s.rememberPrivateValues!("s1", env);
    expect(s.hasPrivateValue!("s1", secretFingerprints({ body: "password is Pq7rT2vW9xYz4bCd6eF" }))).toBe(true);
    expect(s.hasPrivateValue!("s2", env)).toBe(false);
    expect(s.hasPrivateValue!("s1", secretFingerprints("other Zz9yX8wV7uT6sR5q"))).toBe(false);
    expect(s.hasPrivateValue!("s1", [])).toBe(false);
    s.reset("s1");
    expect(s.hasPrivateValue!("s1", env)).toBe(false);
  });
});

it("FileSessionStore keeps only hashes on disk", () => {
  const s = new FileSessionStore(mkdtempSync(join(tmpdir(), "adtl-values-")));
  s.rememberPrivateValues("s1", secretFingerprints("Pq7rT2vW9xYz4bCd6eF"));
  const text = readFileSync(s.valuesPathOf("s1"), "utf8");
  expect(text).not.toContain("Pq7rT2vW9xYz4bCd6eF");
  expect(text.trim()).toMatch(/^[0-9a-f]{32}$/);
});

describe("call.copiesPrivate", () => {
  const config = parseConfig({
    policy: {
      rules: [{ name: "copies", when: { "call.copiesPrivate": true, "tool.egress": ["internal", "external", "public", "unknown"] }, then: "ask" }],
    },
  });
  const session: Label = { integrity: "trusted", confidentiality: "private", origins: [] };
  const input = { session, server: "fs", tool: "write_file", egress: "internal" as const };

  it("matches only calls that copy a private value", () => {
    expect(evaluatePolicy(config.policy, { ...input, copiesPrivate: true }).decision).toBe("ask");
    expect(evaluatePolicy(config.policy, { ...input, copiesPrivate: false }).decision).toBe("allow");
    expect(evaluatePolicy(config.policy, { ...input, egress: "none", copiesPrivate: true }).decision).toBe("allow");
  });

  it("counts as copying when the caller can't tell (fails closed)", () => {
    expect(evaluatePolicy(config.policy, input).decision).toBe("ask");
  });

  it("is only computed for policies that use it", () => {
    expect(usesCopiesPrivate(config.policy)).toBe(true);
    expect(usesCopiesPrivate(parseConfig({}).policy)).toBe(false);
    expect(() => parseConfig({ policy: { rules: [{ name: "x", when: { "call.copiesPrivate": "yes" }, then: "ask" }] } })).toThrow();
  });
});
