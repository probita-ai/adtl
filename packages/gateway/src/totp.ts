/**
 * Approval codes from an authenticator app (TOTP, RFC 6238: SHA-1, 6 digits,
 * 30 seconds), entered in the MCP client's prompt. Codes are made offline on
 * the phone, and a client that accepts prompts by itself can't produce one.
 *
 * The secret lives in the macOS Keychain, or elsewhere in a file only its
 * owner can read (`ADTL_TOTP_FILE`, or `~/.adtl/totp-secret`). An agent with
 * shell access as the same user may still reach either: the hooks ask before
 * commands that mention them, but only a gateway on another machine rules it out.
 *
 * A code is accepted within one time step either way, and once: the last used
 * step is kept in a file, so a code can't be replayed after a restart either.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STEP_SECONDS = 30;
const DIGITS = 6;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** The Keychain service name, also how the hooks recognize commands that read it. */
export const TOTP_KEYCHAIN_SERVICE = "adtl-totp";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const c of text.toUpperCase().replace(/[\s=]/g, "")) {
    const i = BASE32.indexOf(c);
    if (i < 0) throw new Error("The TOTP secret is not valid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

/** The code for one time step (RFC 4226's HOTP with the step as the counter). */
export function totpCode(secret: Buffer, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  const n = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(n % 10 ** digits).padStart(digits, "0");
}

export function totpStep(ms: number): number {
  return Math.floor(ms / 1000 / STEP_SECONDS);
}

/** The `otpauth://` URI authenticator apps scan. */
export function totpUri(secretBase32: string, account: string): string {
  const label = encodeURIComponent(`ADTL:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=ADTL&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

export interface TotpState {
  /** The last time step a code was accepted for. */
  lastStep(): number;
  setLastStep(step: number): void;
}

export class FileTotpState implements TotpState {
  constructor(private readonly path: string) {}

  lastStep(): number {
    try {
      const n = Number(readFileSync(this.path, "utf8").trim());
      return Number.isSafeInteger(n) ? n : Number.MAX_SAFE_INTEGER; // damaged: accept nothing
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw err;
    }
  }

  setLastStep(step: number): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, String(step), { encoding: "utf8", mode: 0o600 });
  }
}

export class TotpVerifier {
  constructor(
    private readonly secret: Buffer,
    private readonly state: TotpState,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if `code` is right for now, give or take one step, and that step or a later one wasn't used yet. */
  verify(code: string): boolean {
    const given = Buffer.from(code.trim());
    const current = totpStep(this.now());
    const last = this.state.lastStep();
    let matched: number | undefined;
    for (const step of [current - 1, current, current + 1]) {
      const expected = Buffer.from(totpCode(this.secret, step));
      if (given.length === expected.length && timingSafeEqual(given, expected) && step > last) matched = step;
    }
    if (matched === undefined) return false;
    this.state.setLastStep(matched);
    return true;
  }
}

export interface TotpSecretStore {
  /** Where the secret is kept, for messages. */
  readonly where: string;
  read(): string | undefined;
  write(secretBase32: string): void;
}

/** `ADTL_TOTP_FILE`, or `~/.adtl/totp-secret`. */
export function totpSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.ADTL_TOTP_FILE?.trim() || join(homedir(), ".adtl", "totp-secret");
}

function totpStatePath(env: NodeJS.ProcessEnv): string {
  return join(dirname(totpSecretPath(env)), "totp-last-step");
}

class FileSecretStore implements TotpSecretStore {
  readonly where: string;
  constructor(private readonly path: string) {
    this.where = path;
  }
  read(): string | undefined {
    try {
      return readFileSync(this.path, "utf8").trim() || undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }
  write(secretBase32: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, `${secretBase32}\n`, { encoding: "utf8", mode: 0o600 });
  }
}

class KeychainSecretStore implements TotpSecretStore {
  readonly where = "the macOS Keychain";
  read(): string | undefined {
    try {
      return execFileSync("security", ["find-generic-password", "-s", TOTP_KEYCHAIN_SERVICE, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
    } catch {
      return undefined; // no such item
    }
  }
  write(secretBase32: string): void {
    execFileSync("security", ["add-generic-password", "-U", "-a", "adtl", "-s", TOTP_KEYCHAIN_SERVICE, "-w", secretBase32], { stdio: "ignore" });
  }
}

/** The macOS Keychain, unless `ADTL_TOTP_FILE` is set; a file on other systems. */
export function totpSecretStore(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): TotpSecretStore {
  return platform === "darwin" && !env.ADTL_TOTP_FILE?.trim() ? new KeychainSecretStore() : new FileSecretStore(totpSecretPath(env));
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The verifier for `gateway.approvals.totp`, or undefined if no secret was set up. */
export function loadTotpVerifier(env: NodeJS.ProcessEnv = process.env, store: TotpSecretStore = totpSecretStore(env)): TotpVerifier | undefined {
  const secret = store.read();
  return secret ? new TotpVerifier(base32Decode(secret), new FileTotpState(totpStatePath(env))) : undefined;
}
