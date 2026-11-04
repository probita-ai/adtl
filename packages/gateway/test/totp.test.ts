import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileTotpState,
  GatewayConfigSchema,
  TotpVerifier,
  base32Decode,
  base32Encode,
  createApprovals,
  handleHook,
  loadTotpVerifier,
  runTotpCommand,
  totpCode,
  totpSecretStore,
  totpStep,
  totpUri,
} from "../src/index.js";
import { InMemorySessionStore, parseConfig } from "@adtl/labels";

const tmp = () => mkdtempSync(join(tmpdir(), "adtl-totp-"));
const secret = Buffer.from("12345678901234567890");

describe("TOTP codes", () => {
  it("matches the RFC 6238 test vectors (SHA-1, 8 digits)", () => {
    for (const [seconds, code] of [[59, "94287082"], [1111111109, "07081804"], [1234567890, "89005924"], [2000000000, "69279037"]] as const) {
      expect(totpCode(secret, totpStep(seconds * 1000), 8)).toBe(code);
    }
  });

  it("round-trips base32, as authenticator apps read it", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("mzxw 6ytb oi==").toString()).toBe("foobar");
    expect(() => base32Decode("not base32!")).toThrow(/base32/);
    expect(totpUri("ABC", "mg")).toBe("otpauth://totp/ADTL%3Amg?secret=ABC&issuer=ADTL&algorithm=SHA1&digits=6&period=30");
  });
});

describe("TotpVerifier", () => {
  const NOW = 1_800_000_000_000;
  const step = totpStep(NOW);
  const make = (now = NOW, path = join(tmp(), "last")) => new TotpVerifier(secret, new FileTotpState(path), () => now);

  it("accepts one step either way, and nothing further", () => {
    expect(make().verify(totpCode(secret, step - 1))).toBe(true);
    expect(make().verify(totpCode(secret, step + 1))).toBe(true);
    expect(make().verify(totpCode(secret, step - 2))).toBe(false);
    expect(make().verify(totpCode(secret, step + 2))).toBe(false);
    expect(make().verify("12345")).toBe(false);
  });

  it("accepts a code once, or any older one, even after a restart", () => {
    const path = join(tmp(), "last");
    expect(make(NOW, path).verify(totpCode(secret, step))).toBe(true);
    expect(make(NOW, path).verify(totpCode(secret, step))).toBe(false);
    expect(make(NOW, path).verify(totpCode(secret, step - 1))).toBe(false);
    expect(make(NOW, path).verify(totpCode(secret, step + 1))).toBe(true);
  });

  it("accepts nothing if the state file is damaged", () => {
    const path = join(tmp(), "last");
    writeFileSync(path, "garbage");
    expect(make(NOW, path).verify(totpCode(secret, step))).toBe(false);
  });
});

describe("adtl-gateway totp", () => {
  const env = () => ({ ADTL_TOTP_FILE: join(tmp(), "totp-secret") });

  it("sets up a secret in a private file, shows a QR code, and won't replace it by accident", async () => {
    const e = env();
    const store = totpSecretStore(e, "linux");
    const r = await runTotpCommand(["setup"], { store });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(store.read());
    expect(r.stdout).toMatch(/[▀▄█]/);
    expect(statSync(e.ADTL_TOTP_FILE).mode & 0o777).toBe(0o600);
    const first = readFileSync(e.ADTL_TOTP_FILE, "utf8");
    expect((await runTotpCommand(["setup"], { store })).exitCode).toBe(1);
    expect(readFileSync(e.ADTL_TOTP_FILE, "utf8")).toBe(first);
    expect((await runTotpCommand(["setup", "--force"], { store })).exitCode).toBe(0);
    expect(readFileSync(e.ADTL_TOTP_FILE, "utf8")).not.toBe(first);
  });

  it("checks a code without using it up", async () => {
    const e = env();
    const store = totpSecretStore(e, "linux");
    await runTotpCommand(["setup"], { store });
    const NOW = 1_800_000_000_000;
    const code = totpCode(base32Decode(store.read()!), totpStep(NOW));
    expect((await runTotpCommand(["check", code], { store, now: () => NOW })).exitCode).toBe(0);
    expect((await runTotpCommand(["check", "000000"], { store, now: () => NOW })).exitCode).toBe(1);
    expect(loadTotpVerifier(e, store)).toBeDefined();
    expect(loadTotpVerifier(env(), totpSecretStore(env(), "linux"))).toBeUndefined();
  });

  it("uses the Keychain on macOS unless a file is named", () => {
    expect(totpSecretStore({}, "darwin").where).toBe("the macOS Keychain");
    expect(totpSecretStore({ ADTL_TOTP_FILE: "/x/s" }, "darwin").where).toBe("/x/s");
  });
});

describe("gateway.approvals.totp", () => {
  it("counts as an approval channel on its own", () => {
    const cfg = GatewayConfigSchema.parse({ upstreams: { a: { command: "x" } }, approvals: { totp: true } });
    const info: string[] = [];
    expect(createApprovals(cfg, {}, { info: (m) => info.push(m), warn: () => {} })).toBeDefined();
    expect(info[0]).toContain("authenticator code");
  });

  it("is protected from the agent by the hooks", () => {
    const opts = { config: parseConfig({}), sessions: new InMemorySessionStore(), protect: { totpPath: "/home/me/.adtl/totp-secret" } };
    const pre = (tool: string, tool_input: unknown) => handleHook({ session_id: "s", hook_event_name: "PreToolUse", tool_name: tool, tool_input, cwd: "/work" }, opts);
    const decision = (o: ReturnType<typeof handleHook>) => (o.stdout?.hookSpecificOutput as { permissionDecision?: string })?.permissionDecision;
    expect(decision(pre("Write", { file_path: "/home/me/.adtl/totp-last-step" }))).toBe("deny");
    expect(decision(pre("Bash", { command: "security find-generic-password -s adtl-totp -w" }))).toBe("ask");
    expect(decision(pre("Bash", { command: "cat ~/.adtl/totp-secret" }))).toBe("ask");
  });
});
