import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { InMemorySessionStore } from "@adtl/labels";
import { parseConfigText } from "@adtl/interceptors";
import { AUDIT_GENESIS, JsonlAuditLog, handleHook, runAuditCommand, verifyAuditLog, type AuditEntry, type HookInput } from "../src/index.js";

const AUDIT_JS = fileURLToPath(new URL("../dist/audit.js", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));

const entry = (n: number): AuditEntry => ({
  ts: `2026-10-19T12:00:0${n % 10}.000Z`,
  sessionId: "s1",
  event: "tools/call",
  server: "github",
  tool: "read_issue",
  outcome: "forwarded",
  durationMs: n,
});

function log(n = 3): { path: string; lines: () => string[]; save: (lines: string[]) => void } {
  const path = join(mkdtempSync(join(tmpdir(), "adtl-audit-")), "audit.jsonl");
  const audit = new JsonlAuditLog(path);
  for (let i = 1; i <= n; i++) audit.write(entry(i));
  const lines = () => readFileSync(path, "utf8").trimEnd().split("\n");
  const save = (ls: string[]) => writeFileSync(path, `${ls.join("\n")}\n`);
  return { path, lines, save };
}

describe("hash-chained audit log", () => {
  it("chains every line to the one before", () => {
    const { path, lines } = log();
    const parsed = lines().map((l) => JSON.parse(l) as { prev: string; hash: string; durationMs: number });
    expect(parsed[0]!.prev).toBe(AUDIT_GENESIS);
    expect(parsed[1]!.prev).toBe(parsed[0]!.hash);
    expect(parsed[2]).toMatchObject({ prev: parsed[1]!.hash, durationMs: 3 });
    expect(verifyAuditLog(path)).toEqual({ ok: true, lines: 3, unchained: 0, last: parsed[2]!.hash });
  });

  it("detects an edited line", () => {
    const { path, lines, save } = log();
    save(lines().map((l, i) => (i === 1 ? l.replace('"forwarded"', '"blocked"') : l)));
    expect(verifyAuditLog(path)).toMatchObject({ ok: false, problem: "line 2 was changed after it was written" });
  });

  it("detects removed, reordered and inserted lines", () => {
    const { path, lines, save } = log();
    const original = lines();
    save([original[0]!, original[2]!]);
    expect(verifyAuditLog(path).problem).toMatch(/^line 2 doesn't follow line 1/);
    save([original[1]!, original[0]!, original[2]!]);
    expect(verifyAuditLog(path).problem).toMatch(/^line 1 doesn't follow/);
    save([original[0]!, JSON.stringify(entry(9)), original[1]!, original[2]!]);
    expect(verifyAuditLog(path).problem).toBe("line 2 has no hash: it was inserted or edited");
  });

  it("continues a log written before the chain, and links to its last line", () => {
    const { path, lines, save } = log(0);
    save([JSON.stringify(entry(1)), JSON.stringify(entry(2))]);
    new JsonlAuditLog(path).write(entry(3));
    expect(verifyAuditLog(path)).toMatchObject({ ok: true, lines: 3, unchained: 2 });
    save(lines().map((l, i) => (i === 1 ? l.replace('"forwarded"', '"blocked"') : l)));
    expect(verifyAuditLog(path).problem).toMatch(/^line 3 doesn't follow line 2/);
  });

  it("starts on a new line after a torn write", () => {
    const { path } = log(1);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"partial":`);
    new JsonlAuditLog(path).write(entry(2));
    expect(readFileSync(path, "utf8").split("\n")).toHaveLength(4);
    expect(verifyAuditLog(path).problem).toBe("line 2 is not valid JSON");
  });

  it("takes over a stale lock", () => {
    const { path } = log(1);
    writeFileSync(`${path}.lock`, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.lock`, old, old);
    new JsonlAuditLog(path).write(entry(2));
    expect(verifyAuditLog(path)).toMatchObject({ ok: true, lines: 2 });
  });

  it("keeps one chain when several processes write at once", async () => {
    const { path } = log(0);
    const script = `const { JsonlAuditLog } = await import(${JSON.stringify(AUDIT_JS)});
      const log = new JsonlAuditLog(process.argv[1]);
      for (let i = 0; i < 25; i++) log.write({ ts: new Date().toISOString(), sessionId: "p" + process.pid, event: "tools/call", server: "x", tool: "t", outcome: "forwarded", durationMs: i });`;
    const run = () =>
      new Promise<number>((done) => spawn(process.execPath, ["--input-type=module", "-e", script, path], { stdio: "inherit" }).on("exit", (c) => done(c ?? 1)));
    expect(await Promise.all([run(), run(), run(), run()])).toEqual([0, 0, 0, 0]);
    expect(verifyAuditLog(path)).toMatchObject({ ok: true, lines: 100 });
  }, 20_000);
});

describe("adtl-gateway audit verify", () => {
  it("verifies the log named in the config, and exits 1 when tampered", async () => {
    const { path, lines, save } = log();
    const config = join(path, "..", "adtl.yaml");
    writeFileSync(config, "gateway:\n  audit: ./audit.jsonl\n");
    const ok = await runAuditCommand(["verify", "-c", config]);
    expect(ok).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("3 lines, chain intact\nlast: sha256:") });
    save(lines().slice(1));
    expect(await runAuditCommand(["verify", path])).toMatchObject({ exitCode: 1, stdout: expect.stringContaining("TAMPERED: line 1") });
    await expect(runAuditCommand(["verify"])).rejects.toThrow(/Give the audit log file/);
    await expect(runAuditCommand(["nope"])).rejects.toThrow(/Unknown audit command/);
  });
});

describe("Claude Code hook", () => {
  it("guards the audit log against the agent", () => {
    const opts = {
      config: parseConfigText(readFileSync(EXAMPLE, "utf8")),
      sessions: new InMemorySessionStore(),
      protect: { auditPath: "/work/adtl-audit.jsonl" },
    };
    const pre = (tool: string, input: Record<string, unknown>): HookInput => ({ session_id: "s", hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: "/work" });
    const decision = (i: HookInput) => (handleHook(i, opts).stdout?.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision;
    expect(decision(pre("Edit", { file_path: "adtl-audit.jsonl" }))).toBe("deny");
    expect(decision(pre("Write", { file_path: "/work/adtl-audit.jsonl.lock" }))).toBe("deny");
    expect(decision(pre("Bash", { command: "sed -i '' 1d adtl-audit.jsonl" }))).toBe("ask");
  });
});
