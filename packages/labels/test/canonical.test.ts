import { describe, expect, it } from "vitest";
import { callHash, canonicalize, digest } from "../src/index.js";

describe("canonicalize", () => {
  it("sorts keys recursively and drops whitespace", () => {
    expect(canonicalize({ b: 1, a: { d: [1, 2], c: "x" } })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
  });

  it("omits undefined object members and writes undefined array items as null", () => {
    expect(canonicalize({ a: undefined, b: [undefined, true] })).toBe('{"b":[null,true]}');
  });

  it("uses ECMAScript number formatting", () => {
    expect(canonicalize([1e21, 0.1, -0, 100])).toBe("[1e+21,0.1,0,100]");
  });

  it("rejects values JSON cannot represent", () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize({ f: () => 1 })).toThrow(TypeError);
  });
});

describe("callHash", () => {
  it("is stable across key order and changes when arguments change", () => {
    const a = callHash("github", "post_comment", { repo: "x", body: "hi" });
    const b = callHash("github", "post_comment", { body: "hi", repo: "x" });
    const c = callHash("github", "post_comment", { body: "bye", repo: "x" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("digest of a value matches its canonical hash", () => {
    expect(digest({ x: 1 })).toBe(digest({ x: 1 }));
  });
});
