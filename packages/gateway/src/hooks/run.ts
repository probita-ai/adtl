/**
 * `adtl-gateway hook --config adtl.yaml`: the command Claude Code runs for
 * PreToolUse, PostToolUse and PostToolUseFailure. Reads the hook event from
 * stdin and answers on stdout (JSON) or stderr (with exit code 2).
 *
 * The config needs no `gateway:` section; if there is one, its `audit` log and
 * `mode` are used, so hook and gateway write to the same audit log.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { FileSessionStore, defaultSessionsDir, defaultSigningKeyPath, trySigner } from "@adtl/labels";
import { Ledger, defaultLedgerPath } from "@adtl/ledger";
import { parseConfigText } from "@adtl/interceptors";
import { parse as parseYaml } from "yaml";
import { JsonlAuditLog } from "../audit.js";
import { failure, handleHook, type HookInput, type HookOutcome } from "./claudeCode.js";

export interface RunHookOptions {
  configPath: string;
  stdin: string;
  gatewayServer?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runHook(opts: RunHookOptions): Promise<HookOutcome> {
  let input: HookInput;
  try {
    input = JSON.parse(opts.stdin) as HookInput;
  } catch {
    // Without the event name we can't tell whether this is a PreToolUse call; refuse it to be safe.
    return failure("PreToolUse", "hook input on stdin is not JSON");
  }
  try {
    const path = resolve(input.cwd ?? process.cwd(), opts.configPath);
    const text = await readFile(path, "utf8");
    const config = parseConfigText(text, path);
    const gw = ((parseYaml(text) ?? {}) as { gateway?: { audit?: unknown; mode?: unknown } }).gateway ?? {};
    const env = opts.env ?? process.env;
    const sessionsDir = defaultSessionsDir(env);
    const ledgerPath = config.ledger.path ? resolve(dirname(path), config.ledger.path) : defaultLedgerPath(env);
    const signer = config.ledger.enabled ? trySigner(defaultSigningKeyPath(env)) : undefined;
    const ledger = config.ledger.enabled
      ? new Ledger(ledgerPath, { retentionDays: config.ledger.retentionDays, ...(signer ? { signer } : {}) })
      : undefined;
    const auditPath = typeof gw.audit === "string" ? resolve(dirname(path), gw.audit) : undefined;
    return handleHook(input, {
      config,
      sessions: new FileSessionStore(sessionsDir),
      ...(ledger ? { ledger } : {}),
      ...(opts.gatewayServer ? { gatewayServer: opts.gatewayServer } : {}),
      mode: gw.mode === "audit" ? "audit" : "active",
      ...(auditPath ? { audit: new JsonlAuditLog(auditPath) } : {}),
      protect: { configPath: path, sessionsDir, ledgerPath, ...(auditPath ? { auditPath } : {}), signingKeyPath: defaultSigningKeyPath(env) },
    });
  } catch (err) {
    return failure(input.hook_event_name, (err as Error).message);
  }
}
