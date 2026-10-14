#!/usr/bin/env node
/**
 * adtl-gateway: an MCP server for your agent that proxies to your real MCP
 * servers through ADTL's interceptors.
 *
 *   adtl-gateway --config adtl.yaml [--audit]
 *
 * Point your MCP client (e.g. Claude Code's .mcp.json) at this command.
 * Logs go to stderr; stdout carries MCP JSON-RPC only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnvExpansionError } from "./config.js";
import { GATEWAY_VERSION } from "./gateway.js";
import { GatewayConfigError, loadGatewayConfig, startGateway } from "./startup.js";

const USAGE = `Usage: adtl-gateway --config <adtl.yaml> [--audit]

Runs an MCP server over stdio that forwards tool calls to the upstream
servers in the config, checking and labeling each call with ADTL.

Options:
  -c, --config <path>  ADTL config file with a gateway: section. Required.
      --audit          Log what would be stopped, but stop nothing
                       (same as gateway.mode: audit).
  -v, --version        Print the version and exit.
  -h, --help           Show this help.`;

interface Args {
  config?: string;
  audit?: boolean;
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
    else if (a === "--audit") out.audit = true;
    else throw new GatewayConfigError(`Unknown argument: ${a}\n\n${USAGE}`);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // --help and --version print to stdout and exit; MCP is never served in these modes.
  if (args.help) return void console.log(USAGE);
  if (args.version) return void console.log(GATEWAY_VERSION);
  if (!args.config) throw new GatewayConfigError(`Missing --config\n\n${USAGE}`);

  const loaded = await loadGatewayConfig(args.config);
  if (args.audit) loaded.gateway.mode = "audit";
  const started = await startGateway(loaded);
  const server = started.gateway.createServer();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await server.close().catch(() => undefined);
    await started.close();
    process.exit(0);
  };
  server.onclose = () => void shutdown();
  // The agent closing our stdin means the session is over; don't wait for a signal.
  process.stdin.on("end", () => void shutdown());
  process.stdin.on("close", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await server.connect(new StdioServerTransport());
  console.error(`[adtl-gateway] ${GATEWAY_VERSION} ready (session ${started.gateway.sessionId})`);
}

main().catch((err: unknown) => {
  const known = err instanceof GatewayConfigError || err instanceof EnvExpansionError;
  console.error(known ? `[adtl-gateway] ${(err as Error).message}` : err);
  process.exit(1);
});
