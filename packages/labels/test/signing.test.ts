import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyId, loadOrCreateSigner, loadSigner, signCanonical, verifyCanonical, verifySignature } from "../src/index.js";

const keyPath = () => join(mkdtempSync(join(tmpdir(), "adtl-key-")), "sub", "signing-key.pem");

describe("signing keys", () => {
  it("creates a key on first use, owner-only, and reuses it", () => {
    const path = keyPath();
    expect(loadSigner(path)).toBeUndefined();
    const a = loadOrCreateSigner(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(a.publicKey).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    expect(a.keyId).toBe(keyId(a.publicKey));
    expect(loadOrCreateSigner(path).publicKey).toBe(a.publicKey);
    expect(loadSigner(path)?.publicKey).toBe(a.publicKey);
  });

  it("signs and verifies, and rejects other data, keys and garbage", () => {
    const s = loadOrCreateSigner(keyPath());
    const other = loadOrCreateSigner(keyPath());
    const sig = s.sign("hello");
    expect(verifySignature(s.publicKey, "hello", sig)).toBe(true);
    expect(verifySignature(s.publicKey, "hello!", sig)).toBe(false);
    expect(verifySignature(other.publicKey, "hello", sig)).toBe(false);
    expect(verifySignature("rsa:abc", "hello", sig)).toBe(false);
    expect(verifySignature(s.publicKey, "hello", "not-a-signature")).toBe(false);
  });

  it("signs the canonical form, so key order doesn't matter", () => {
    const s = loadOrCreateSigner(keyPath());
    const sig = signCanonical(s, { b: 1, a: [1, 2] });
    expect(verifyCanonical(s.publicKey, { a: [1, 2], b: 1 }, sig)).toBe(true);
    expect(verifyCanonical(s.publicKey, { a: [1, 3], b: 1 }, sig)).toBe(false);
  });
});
