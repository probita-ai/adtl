/**
 * `adtl-gateway receipt` and `adtl-gateway key`.
 *
 *   adtl-gateway receipt list [<log>] [-c adtl.yaml]
 *   adtl-gateway receipt <session> [<log>] [-c adtl.yaml] [-o receipt.json]
 *   adtl-gateway receipt verify <receipt.json> [--log <log>] [--key ed25519:…]
 *   adtl-gateway key
 */
import { readFile, writeFile } from "node:fs/promises";
import { defaultSigningKeyPath, loadOrCreateSigner } from "@adtl/labels";
import { resolveAuditPath } from "./auditCli.js";
import { buildReceipt, listSessions, verifyReceipt, type Receipt } from "./receipt.js";

export const RECEIPT_USAGE = `Usage: adtl-gateway receipt list [<log>] [-c <adtl.yaml>]
       adtl-gateway receipt <session> [<log>] [-c <adtl.yaml>] [-o <receipt.json>]
       adtl-gateway receipt verify <receipt.json> [--log <log>] [--key <ed25519:...>]
       adtl-gateway key

A receipt is a signed summary of every call one session made through the
gateway and the Claude Code hooks: tool, outcome, decision, approver, call
hash, result label and the hash of each audit log line. It is built from the
hash-chained audit log (gateway.audit) and signed with this machine's key
(ADTL_SIGNING_KEY, or ~/.adtl/signing-key.pem).

  list     Sessions in the log, newest first.
  verify   Check the signature; with --log, also that the receipt lists every
           line the session wrote; with --key, who signed it (exit 1 if not).
  key      Print this machine's public key, to give to whoever checks receipts.`;

export interface ReceiptCommandResult {
  stdout: string;
  exitCode: number;
}

export async function runKeyCommand(env: NodeJS.ProcessEnv = process.env): Promise<ReceiptCommandResult> {
  const path = defaultSigningKeyPath(env);
  const signer = loadOrCreateSigner(path);
  return { stdout: `${signer.publicKey}\nkey id: ${signer.keyId}\nfile: ${path}`, exitCode: 0 };
}

export async function runReceiptCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<ReceiptCommandResult> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "-h" || cmd === "--help") return { stdout: RECEIPT_USAGE, exitCode: 0 };
  let config: string | undefined;
  let out: string | undefined;
  let log: string | undefined;
  let key: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "-c" || a === "--config") config = rest[++i];
    else if (a === "-o" || a === "--out") out = rest[++i];
    else if (a === "--log") log = rest[++i];
    else if (a === "--key") key = rest[++i];
    else if (a.startsWith("-")) throw new Error(`Unknown argument: ${a}\n\n${RECEIPT_USAGE}`);
    else args.push(a);
  }

  if (cmd === "verify") {
    if (args.length !== 1) throw new Error(`receipt verify needs one receipt file\n\n${RECEIPT_USAGE}`);
    const receipt = JSON.parse(await readFile(args[0]!, "utf8")) as Receipt;
    const r = verifyReceipt(receipt, { ...(log ? { logPath: log } : {}), ...(key ? { trustedKey: key } : {}) });
    if (!r.ok) return { stdout: `${args[0]}: INVALID: ${r.problem}`, exitCode: 1 };
    const checked = [`signed by ${receipt.signer}`, ...(key ? ["the expected key"] : []), ...(log ? ["matches the log"] : [])];
    return { stdout: `${args[0]}: valid (${checked.join(", ")}): ${receipt.counts.calls} calls in session ${receipt.sessionId}`, exitCode: 0 };
  }

  if (cmd === "list") {
    if (args.length > 1) throw new Error(`Unexpected argument: ${args[1]}\n\n${RECEIPT_USAGE}`);
    const path = await resolveAuditPath(args[0], config, RECEIPT_USAGE);
    const sessions = listSessions(path);
    if (sessions.length === 0) return { stdout: `${path}: no sessions`, exitCode: 0 };
    return { stdout: sessions.map((s) => `${s.last}  ${s.sessionId}  ${s.calls} call${s.calls === 1 ? "" : "s"}`).join("\n"), exitCode: 0 };
  }

  if (args.length > 1) throw new Error(`Unexpected argument: ${args[1]}\n\n${RECEIPT_USAGE}`);
  const path = await resolveAuditPath(args[0], config, RECEIPT_USAGE);
  const receipt = buildReceipt(path, cmd, loadOrCreateSigner(defaultSigningKeyPath(env)));
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  if (out) {
    await writeFile(out, json);
    return { stdout: `${out}: receipt for ${receipt.counts.calls} calls in session ${cmd}`, exitCode: 0 };
  }
  return { stdout: json.trimEnd(), exitCode: 0 };
}
