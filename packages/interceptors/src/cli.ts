#!/usr/bin/env node
/**
 * adtl-interceptors: run the ADTL Interceptor Server over stdio.
 *
 *   adtl-interceptors --config adtl.yaml
 *
 * Logs go to stderr; stdout carries MCP JSON-RPC only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AdtlInterceptors, VERSION } from "./adtlInterceptors.js";
import { ConfigError, loadConfigFile } from "./loadConfig.js";
import { createInterceptorServer } from "./server.js";

const USAGE = `Usage: adtl-interceptors --config <adtl.yaml>

Runs the ADTL interceptor server (adtl.label, adtl.policy) over stdio.

Options:
  -c, --config <path>  ADTL config file (YAML or JSON). Required.
  -v, --version        Print the version and exit.
  -h, --help           Show this help.`;

function parseArgs(argv: string[]): { config?: string; help?: boolean; version?: boolean } {
  const out: { config?: string; help?: boolean; version?: boolean } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-c" || a === "--config") out.config = argv[++i];
    else if (a?.startsWith("--config=")) out.config = a.slice("--config=".length);
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
  const server = createInterceptorServer(new AdtlInterceptors({ config }));
  await server.connect(new StdioServerTransport());
  console.error(`adtl-interceptors ${VERSION} ready (config: ${args.config})`);
}

main().catch((err: unknown) => {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
});
