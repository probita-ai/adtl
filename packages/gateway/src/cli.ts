#!/usr/bin/env node
/**
 * adtl-gateway: an MCP server for your agent that proxies to your real MCP
 * servers through ADTL's interceptors.
 *
 *   adtl-gateway --config adtl.yaml [--audit]
 *   adtl-gateway init --config adtl.yaml [--write]
 *   adtl-gateway hook --config adtl.yaml [--gateway-server adtl]
 *
 * Point your MCP client (e.g. Claude Code's .mcp.json) at this command.
 * Logs go to stderr; stdout carries MCP JSON-RPC only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnvExpansionError } from "./config.js";
import { GATEWAY_VERSION } from "./gateway.js";
import { runHook } from "./hooks/run.js";
import { runInit, type InitResult } from "./init/run.js";
import { GatewayConfigError, loadGatewayConfig, startGateway } from "./startup.js";

const USAGE = `Usage: adtl-gateway --config <adtl.yaml> [--audit]
       adtl-gateway init --config <adtl.yaml> [--write]
       adtl-gateway hook --config <adtl.yaml> [--gateway-server <name>]

Runs an MCP server over stdio that forwards tool calls to the upstream
servers in the config, checking and labeling each call with ADTL.

Options:
  -c, --config <path>  ADTL config file with a gateway: section. Required.
      --audit          Log what would be stopped, but stop nothing
                       (same as gateway.mode: audit).
  -v, --version        Print the version and exit.

init:
  Connects to every upstream, lists its tools, and drafts a labeling rule
  for each tool the config doesn't cover yet (presets for GitHub,
  filesystem and fetch; MCP tool hints otherwise). Existing entries are
  never changed. Prints the updated config; review it before using it.
      --write          Update the config file in place (original kept as .bak).

hook:
  The Claude Code hook for PreToolUse, PostToolUse and PostToolUseFailure.
  Labels built-in tools (WebFetch, Read, Bash, ...) and MCP servers outside
  the gateway, and runs the same policy on them, sharing the session label
  with the gateway. Reads the hook event from stdin.
      --gateway-server <name>
                       The gateway's name in Claude Code's MCP config; its
                       tools are checked by the gateway and skipped here.
                       Default: adtl.

  -h, --help           Show this help.`;

interface Args {
  init?: boolean;
  hook?: boolean;
  gatewayServer?: string;
  write?: boolean;
  config?: string;
  audit?: boolean;
  help?: boolean;
  version?: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (i === 0 && a === "init") out.init = true;
    else if (i === 0 && a === "hook") out.hook = true;
    else if (a === "--gateway-server" && out.hook) out.gatewayServer = argv[++i];
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "-c" || a === "--config") out.config = argv[++i];
    else if (a?.startsWith("--config=")) out.config = a.slice("--config=".length);
    else if (a === "--audit") out.audit = true;
    else if (a === "--write" && out.init) out.write = true;
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
  if (args.init) return init(args.config, args.write === true);
  if (args.hook) return hook(args.config, args.gatewayServer);

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

function summarize(r: InitResult, path: string, write: boolean): string {
  const lines = r.reports.map((s) => {
    const parts = [`${s.added.length} tools added`];
    if (s.kept.length) parts.push(`${s.kept.length} kept`);
    if (s.addedDefaults) parts.push("defaults added");
    if (s.stale.length) parts.push(`no longer offered: ${s.stale.join(", ")}`);
    return `  ${s.id} (${s.preset ? `preset ${s.preset}` : "from tool hints, review"}): ${parts.join("; ")}`;
  });
  for (const f of r.failed) lines.push(`  ${f.id}: could not connect, skipped (${f.error})`);
  const changed = r.reports.some((s) => s.added.length || s.addedDefaults);
  const tail = !changed
    ? "Nothing to add."
    : write
      ? `Updated ${path} (original saved as ${path}.bak). Review every line marked "review".`
      : "Nothing written. Review the config above, then re-run with --write.";
  return `${lines.join("\n")}\n${tail}`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function hook(config: string, gatewayServer?: string): Promise<void> {
  const out = await runHook({ configPath: config, stdin: await readStdin(), ...(gatewayServer ? { gatewayServer } : {}) });
  if (out.stdout) process.stdout.write(`${JSON.stringify(out.stdout)}\n`);
  if (out.stderr) process.stderr.write(`${out.stderr}\n`);
  process.exitCode = out.exitCode;
}

async function init(path: string, write: boolean): Promise<void> {
  const result = await runInit({ path, write });
  if (!write) process.stdout.write(result.text);
  console.error(`[adtl-gateway] init\n${summarize(result, path, write)}`);
  if (result.failed.length && !result.reports.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const known = err instanceof GatewayConfigError || err instanceof EnvExpansionError;
  console.error(known ? `[adtl-gateway] ${(err as Error).message}` : err);
  // For Claude Code hooks only exit code 2 stops the call; any other code lets it run.
  process.exit(process.argv[2] === "hook" ? 2 : 1);
});
