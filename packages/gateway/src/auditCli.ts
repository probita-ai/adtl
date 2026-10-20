/**
 * `adtl-gateway audit`: check the audit log by hand.
 *
 *   adtl-gateway audit verify [<file>] [-c adtl.yaml]
 *
 * Without a file, the log is `gateway.audit` from the config.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { verifyAuditLog } from "./audit.js";

export const AUDIT_USAGE = `Usage: adtl-gateway audit verify [<file>] [-c <adtl.yaml>]

The audit log is hash-chained. verify checks that no line was edited,
removed, reordered or inserted (exit 1 if one was), and prints the hash of
the last line. Lines cut off the end are not detected; note that hash
somewhere else if you need to check later. Without <file>, the log is
gateway.audit from the config.`;

export interface AuditCommandResult {
  stdout: string;
  exitCode: number;
}

export async function runAuditCommand(argv: string[]): Promise<AuditCommandResult> {
  const [cmd, ...rest] = argv;
  let config: string | undefined;
  const files: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-c" || a === "--config") config = rest[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown argument: ${a}\n\n${AUDIT_USAGE}`);
    else files.push(a);
  }
  if (cmd === undefined || cmd === "-h" || cmd === "--help") return { stdout: AUDIT_USAGE, exitCode: 0 };
  if (cmd !== "verify") throw new Error(`Unknown audit command: ${cmd}\n\n${AUDIT_USAGE}`);
  if (files.length > 1) throw new Error(`Unexpected argument: ${files[1]}\n\n${AUDIT_USAGE}`);

  let path = files[0] && resolve(files[0]);
  if (!path) {
    if (!config) throw new Error(`Give the audit log file, or -c <adtl.yaml> with gateway.audit set\n\n${AUDIT_USAGE}`);
    const abs = resolve(config);
    const gw = ((parseYaml(await readFile(abs, "utf8")) ?? {}) as { gateway?: { audit?: unknown } }).gateway ?? {};
    if (typeof gw.audit !== "string") throw new Error(`${config} has no gateway.audit`);
    path = resolve(dirname(abs), gw.audit);
  }

  const v = verifyAuditLog(path);
  if (!v.ok) return { stdout: `${path}: TAMPERED: ${v.problem}`, exitCode: 1 };
  const before = v.unchained ? ` (${v.unchained} written before the chain)` : "";
  return { stdout: `${path}: ${v.lines} lines${before}, chain intact${v.last ? `\nlast: ${v.last}` : ""}`, exitCode: 0 };
}
