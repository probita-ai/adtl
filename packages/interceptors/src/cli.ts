#!/usr/bin/env node
/**
 * adtl-interceptors: run the ADTL Interceptor Server over stdio.
 *
 *   adtl-interceptors --config adtl.yaml [--sessions-dir <dir>]
 *
 * Logs go to stderr; stdout carries MCP JSON-RPC only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileSessionStore } from "@adtl/labels";
import { Ledger, defaultLedgerPath } from "@adtl/ledger";
import { dirname, resolve } from "node:path";
import { AdtlInterceptors, VERSION } from "./adtlInterceptors.js";
import { ConfigError, loadConfigFile } from "./loadConfig.js";
import { createInterceptorServer } from "./server.js";

const USAGE = `Usage: adtl-interceptors --config <adtl.yaml> [--sessions-dir <dir>]

Runs the ADTL interceptor server (adtl.label, adtl.policy) over stdio.

Options:
  -c, --config <path>  ADTL config file (YAML or JSON). Required.
      --sessions-dir <dir>
                       Keep session labels in files in <dir>, shared with
                       other ADTL processes such as Claude Code hooks.
                       Default: ADTL_SESSIONS_DIR if set, else in memory.
  -v, --version        Print the version and exit.
  -h, --help           Show this help.`;

interface Args {
  config?: string;
  sessionsDir?: string;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-c" || a === "--config") out.config = argv[++i];
    else if (a?.startsWith("--config=")) out.config = a.slice("--config=".length);
    else if (a === "--sessions-dir") out.sessionsDir = argv[++i];
    else throw new ConfigError(`Unknown argument: ${a}\n\n${USAGE}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // --help and --version print to stdout and exit; MCP is never served in these modes.
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.version) {
    console.log(VERSION);
    return;
  }
  if (!args.config) throw new ConfigError(`Missing --config\n\n${USAGE}`);

  const config = await loadConfigFile(args.config);
  const sessionsDir = args.sessionsDir ?? (process.env.ADTL_SESSIONS_DIR?.trim() || undefined);
  const sessions = sessionsDir ? new FileSessionStore(sessionsDir) : undefined;
  const ledgerPath = config.ledger.path ? resolve(dirname(resolve(args.config)), config.ledger.path) : defaultLedgerPath();
  const ledger = config.ledger.enabled ? new Ledger(ledgerPath, { retentionDays: config.ledger.retentionDays }) : undefined;
  const server = createInterceptorServer(
    new AdtlInterceptors({ config, ...(sessions ? { sessions } : {}), ...(ledger ? { ledger } : {}) }),
  );
  await server.connect(new StdioServerTransport());
  console.error(`adtl-interceptors ${VERSION} ready (config: ${args.config}${sessionsDir ? `, sessions: ${sessionsDir}` : ""}${ledger ? `, ledger: ${ledger.path}` : ""})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
