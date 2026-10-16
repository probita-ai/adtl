/**
 * `adtl-gateway ledger`: look after the label ledger by hand.
 *
 *   adtl-gateway ledger stats                 [-c adtl.yaml]
 *   adtl-gateway ledger verify                [-c adtl.yaml]
 *   adtl-gateway ledger declassify <file>...  [-c adtl.yaml] [--reason <text>]
 *
 * `declassify` clears the label of each file's current content, after you've
 * checked it. It is meant to be run by a person; the Claude Code hook asks
 * before letting the agent run it.
 */
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { parseConfigText } from "@adtl/interceptors";
import { Ledger, chunkHashes, defaultLedgerPath } from "@adtl/ledger";

export const LEDGER_USAGE = `Usage: adtl-gateway ledger stats [-c <adtl.yaml>]
       adtl-gateway ledger verify [-c <adtl.yaml>]
       adtl-gateway ledger declassify <file>... [-c <adtl.yaml>] [--reason <text>]

The ledger remembers content written by sessions that had read untrusted or
private data, and re-labels it when it is read back. It lives in
ledger.path from the config, else ADTL_LEDGER, else ~/.adtl/ledger.db.

  stats       Count entries.
  verify      Check that no entry was changed or removed (exit 1 if one was).
  declassify  Clear the label of each file's current content. Check the
              files first: after this, ADTL treats that content as clean.`;

export interface LedgerCommandResult {
  stdout: string;
  exitCode: number;
}

export async function runLedgerCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<LedgerCommandResult> {
  const [cmd, ...rest] = argv;
  let config: string | undefined;
  let reason: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-c" || a === "--config") config = rest[++i];
    else if (a === "--reason") reason = rest[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown argument: ${a}\n\n${LEDGER_USAGE}`);
    else files.push(a);
  }
  if (cmd === undefined || cmd === "-h" || cmd === "--help") return { stdout: LEDGER_USAGE, exitCode: 0 };
  if (!["stats", "verify", "declassify"].includes(cmd)) throw new Error(`Unknown ledger command: ${cmd}\n\n${LEDGER_USAGE}`);
  if (cmd === "declassify" && files.length === 0) throw new Error(`declassify needs at least one file\n\n${LEDGER_USAGE}`);
  if (cmd !== "declassify" && files.length > 0) throw new Error(`Unexpected argument: ${files[0]}\n\n${LEDGER_USAGE}`);

  let path = defaultLedgerPath(env);
  let retentionDays: number | undefined;
  if (config) {
    const abs = resolve(config);
    const parsed = parseConfigText(await readFile(abs, "utf8"), abs);
    if (parsed.ledger.path) path = resolve(dirname(abs), parsed.ledger.path);
    retentionDays = parsed.ledger.retentionDays;
  }
  const ledger = new Ledger(path, retentionDays ? { retentionDays } : {});
  try {
    if (cmd === "stats") {
      const s = ledger.stats();
      return { stdout: `${path}\n${s.records} records from ${s.writers} sessions, ${s.clears} declassified chunks (${s.entries} entries)`, exitCode: 0 };
    }
    if (cmd === "verify") {
      const v = ledger.verify();
      return v.ok
        ? { stdout: `${path}: ${v.entries} entries, chain intact`, exitCode: 0 }
        : { stdout: `${path}: TAMPERED: ${v.problem}`, exitCode: 1 };
    }
    const by = `user:${userInfo().username}`;
    const lines: string[] = [];
    for (const f of files) {
      const n = ledger.declassify(chunkHashes(await readFile(resolve(f), "utf8")), by, reason);
      lines.push(n ? `${f}: cleared ${n} labeled chunk${n === 1 ? "" : "s"}` : `${f}: nothing labeled`);
    }
    return { stdout: lines.join("\n"), exitCode: 0 };
  } finally {
    ledger.close();
  }
}
