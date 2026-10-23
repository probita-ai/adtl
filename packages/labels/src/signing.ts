/**
 * Ed25519 signatures for ADTL records: session receipts, ledger entries and
 * declassifications.
 *
 * Each machine has one signing key, `~/.adtl/signing-key.pem` (or the path in
 * ADTL_SIGNING_KEY), created on first use and readable only by its owner.
 * Public keys are written `ed25519:<base64url of the 32-byte key>`, so a
 * record can name its signer and anyone can check it.
 *
 * A signature shows which key signed a record and that it hasn't changed
 * since. It doesn't stop someone who can read the key file, such as an agent
 * with shell access as the same user, from signing records of their own:
 * keep the key out of the agent's reach if that matters.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalize } from "./canonical.js";

export const SIGNING_KEY_ENV = "ADTL_SIGNING_KEY";

export function defaultSigningKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[SIGNING_KEY_ENV] || join(homedir(), ".adtl", "signing-key.pem");
}

export interface Signer {
  /** `ed25519:<base64url>` */
  readonly publicKey: string;
  /** Short id for logs: the first 16 hex characters of the public key's SHA-256. */
  readonly keyId: string;
  /** Base64url signature over the UTF-8 bytes of `data`. */
  sign(data: string): string;
}

const PREFIX = "ed25519:";

function publicKeyString(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 key");
  return `${PREFIX}${jwk.x}`;
}

/** Short id of a public key, for logs and listings. */
export function keyId(publicKey: string): string {
  return createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 16);
}

/** A signer from a PEM-encoded Ed25519 private key. */
export function signerFromPem(pem: string): Signer {
  const priv = createPrivateKey(pem);
  if (priv.asymmetricKeyType !== "ed25519") throw new Error("the signing key must be an Ed25519 key");
  const publicKey = publicKeyString(createPublicKey(priv));
  return {
    publicKey,
    keyId: keyId(publicKey),
    sign: (data) => sign(null, Buffer.from(data, "utf8"), priv).toString("base64url"),
  };
}

/**
 * Load the signing key at `path`, creating it (mode 0600) if there is none.
 * Two processes creating it at once end up with the same key.
 */
export function loadOrCreateSigner(path: string = defaultSigningKeyPath()): Signer {
  try {
    return signerFromPem(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, pem);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    // Another process created it first: use theirs.
    return signerFromPem(readFileSync(path, "utf8"));
  }
  return signerFromPem(pem);
}

/** The signing key at `path`, or undefined if there is none yet. Never creates one. */
export function loadSigner(path: string = defaultSigningKeyPath()): Signer | undefined {
  try {
    return signerFromPem(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * The signing key, created if needed, or undefined if it can't be read or
 * written (`warn` says why). Signing is an extra: labeling goes on without it.
 */
export function trySigner(path: string = defaultSigningKeyPath(), warn: (msg: string) => void = () => {}): Signer | undefined {
  try {
    return loadOrCreateSigner(path);
  } catch (err) {
    warn(`signing key ${path}: ${(err as Error).message}; entries are not signed`);
    return undefined;
  }
}

/** True if `signature` is `publicKey`'s signature over `data`. */
export function verifySignature(publicKey: string, data: string, signature: string): boolean {
  if (!publicKey.startsWith(PREFIX)) return false;
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey.slice(PREFIX.length) }, format: "jwk" });
    return verify(null, Buffer.from(data, "utf8"), key, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

/** Sign the canonical (JCS-style) form of `value`. */
export function signCanonical(signer: Signer, value: unknown): string {
  return signer.sign(canonicalize(value));
}

/** Check a signature made by signCanonical. */
export function verifyCanonical(publicKey: string, value: unknown, signature: string): boolean {
  return verifySignature(publicKey, canonicalize(value), signature);
}
