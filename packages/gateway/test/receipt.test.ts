import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore, loadOrCreateSigner, signCanonical } from "@adtl/labels";
import { parseConfigText } from "@adtl/interceptors";
import { fileURLToPath } from "node:url";
import {
  JsonlAuditLog,
  buildReceipt,
  handleHook,
  listSessions,
  runKeyCommand,
  runReceiptCommand,
  verifyReceipt,
  type AuditEntry,
  type HookInput,
  type Receipt,
} from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));

const entry = (sessionId: string, n: number, extra: Partial<AuditEntry> = {}): AuditEntry => ({
  ts: `2026-10-22T12:00:0${n}.000Z`,
  sessionId,
  event: "tools/call",
  server: "github",
  tool: n === 2 ? "post_comment" : "read_issue",
  outcome: "forwarded",
  decision: "allow",
  callHash: `sha256:${n}`,
  label: { integrity: "untrusted", confidentiality: "public", origins: [{ server: "github", tool: "read_issue" }] },
  durationMs: 1,
  ...extra,
});

function world() {
  const dir = mkdtempSync(join(tmpdir(), "adtl-receipt-"));
  const log = join(dir, "audit.jsonl");
  const audit = new JsonlAuditLog(log);
  audit.write(entry("mon", 1));
  audit.write(entry("other", 1));
  audit.write(entry("mon", 2, { decision: "ask", approval: { outcome: "approved", approver: "alice", channel: "ntfy:alice", waitedMs: 3 } }));
  audit.write(entry("mon", 3, { outcome: "blocked", decision: "block" }));
  const keyPath = join(dir, "key.pem");
  return { dir, log, keyPath, signer: loadOrCreateSigner(keyPath) };
}

describe("session receipts", () => {
  it("lists the session's calls with counts, approver and labels, signed", () => {
    const w = world();
    const r = buildReceipt(w.log, "mon", w.signer, new Date("2026-10-22T13:00:00Z"));
    expect(r).toMatchObject({
      type: "adtl.receipt.v1",
      sessionId: "mon",
      createdAt: "2026-10-22T13:00:00.000Z",
      counts: { calls: 3, forwarded: 2, blocked: 1, asked: 0, upstreamErrors: 0, approved: 1, denied: 0 },
      signer: w.signer.publicKey,
    });
    expect(r.calls[1]).toMatchObject({ tool: "post_comment", decision: "ask", approver: "alice", callHash: "sha256:2", label: { integrity: "untrusted", confidentiality: "public" } });
    expect(r.calls[0]).not.toHaveProperty("label.origins");
    expect(verifyReceipt(r, { logPath: w.log, trustedKey: w.signer.publicKey })).toEqual({ ok: true });
  });

  it("rejects a changed receipt, another signer, and a receipt that leaves out a call", () => {
    const w = world();
    const r = buildReceipt(w.log, "mon", w.signer);
    expect(verifyReceipt({ ...r, counts: { ...r.counts, blocked: 0 } }).problem).toMatch(/changed or forged/);
    const other = loadOrCreateSigner(join(w.dir, "other.pem"));
    expect(verifyReceipt(r, { trustedKey: other.publicKey }).problem).toMatch(/not the expected key/);
    // Drop the blocked call and sign again: the signature is fine, the log says otherwise.
    const { signature: _, ...rest } = r;
    const shorter = { ...rest, calls: r.calls.slice(0, 1).concat(r.calls.slice(2)) };
    const resigned: Receipt = { ...shorter, signature: signCanonical(w.signer, shorter) };
    expect(verifyReceipt(resigned).ok).toBe(true);
    expect(verifyReceipt(resigned, { logPath: w.log }).problem).toMatch(/doesn't list exactly the session's calls/);
  });

  it("refuses to issue a receipt from a tampered log, or for an unknown session", () => {
    const w = world();
    expect(() => buildReceipt(w.log, "nobody", w.signer)).toThrow(/no entries for session nobody/);
    writeFileSync(w.log, readFileSync(w.log, "utf8").replace('"blocked"', '"forwarded"'));
    expect(() => buildReceipt(w.log, "mon", w.signer)).toThrow(/tampered with/);
  });

  it("lists sessions, newest first", () => {
    expect(listSessions(world().log)).toEqual([
      { sessionId: "mon", calls: 3, last: "2026-10-22T12:00:03.000Z" },
      { sessionId: "other", calls: 1, last: "2026-10-22T12:00:01.000Z" },
    ]);
  });
});

describe("adtl-gateway receipt and key", () => {
  it("lists, writes and verifies receipts, and prints the public key", async () => {
    const w = world();
    const env = { ADTL_SIGNING_KEY: w.keyPath };
    expect((await runReceiptCommand(["list", w.log], env)).stdout).toContain("mon  3 calls");
    const out = join(w.dir, "mon.json");
    expect((await runReceiptCommand(["mon", w.log, "-o", out], env)).stdout).toContain("receipt for 3 calls");
    const verified = await runReceiptCommand(["verify", out, "--log", w.log, "--key", w.signer.publicKey], env);
    expect(verified).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("valid (signed by") });
    writeFileSync(out, readFileSync(out, "utf8").replace('"blocked": 1', '"blocked": 0'));
    expect(await runReceiptCommand(["verify", out], env)).toMatchObject({ exitCode: 1, stdout: expect.stringContaining("INVALID") });
    expect((await runKeyCommand(env)).stdout).toContain(w.signer.publicKey);
    await expect(runReceiptCommand(["verify"], env)).rejects.toThrow(/needs one receipt file/);
  });
});

describe("Claude Code hook", () => {
  it("guards the signing key against the agent", () => {
    const opts = { config: parseConfigText(readFileSync(EXAMPLE, "utf8")), sessions: new InMemorySessionStore(), protect: { signingKeyPath: "/home/me/.adtl/signing-key.pem" } };
    const pre = (tool: string, input: Record<string, unknown>): HookInput => ({ session_id: "s", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: "/work" });
    const decision = (i: HookInput) => (handleHook(i, opts).stdout?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;
    expect(decision(pre("Write", { file_path: "/home/me/.adtl/signing-key.pem" }))).toBe("deny");
    expect(decision(pre("Bash", { command: "cat ~/.adtl/signing-key.pem" }))).toBe("ask");
  });
});
