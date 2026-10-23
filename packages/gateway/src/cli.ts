#!/usr/bin/env node
/**
 * adtl-gateway: an MCP server for your agent that proxies to your real MCP
 * servers through ADTL's interceptors.
 *
 *   adtl-gateway --config adtl.yaml [--audit]
 *   adtl-gateway init --config adtl.yaml [--from .mcp.json] [--write]
 *   adtl-gateway hook --config adtl.yaml [--gateway-server adtl]
 *   adtl-gateway ledger stats|verify|declassify|declassified
 *   adtl-gateway audit verify [<file>]
 *   adtl-gateway receipt list|<session>|verify <file>
 *   adtl-gateway key
 *   adtl-gateway playground [--port 4317] [--no-open]
 *
 * Point your MCP client (e.g. Claude Code's .mcp.json) at this command.
 * Logs go to stderr; stdout carries MCP JSON-RPC only.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnvExpansionError } from "./config.js";
import { GATEWAY_VERSION } from "./gateway.js";
import { runAuditCommand } from "./auditCli.js";
import { runKeyCommand, runReceiptCommand } from "./receiptCli.js";
import { runPlayground } from "./playgroundCli.js";
import { runHook } from "./hooks/run.js";
import { runLedgerCommand } from "./ledgerCli.js";
import { runInit, type InitResult } from "./init/run.js";
import { GatewayConfigError, loadGatewayConfig, startGateway } from "./startup.js";

const USAGE = `Usage: adtl-gateway --config <adtl.yaml> [--audit]
       adtl-gateway init --config <adtl.yaml> [--from <.mcp.json>] [--write]
       adtl-gateway hook --config <adtl.yaml> [--gateway-server <name>]
       adtl-gateway ledger stats|verify|declassify|declassified  (see: adtl-gateway ledger --help)
       adtl-gateway audit verify [<file>]  (see: adtl-gateway audit --help)
       adtl-gateway receipt list|<session>|verify <file>  (see: adtl-gateway receipt --help)
       adtl-gateway key
       adtl-gateway playground [--port <n>] [--no-open]  (a local web UI with fake servers)

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
      --from <file>    First import the MCP servers of a client config (Claude
                       Code's .mcp.json, or any file with "mcpServers") into
                       gateway.upstreams, creating the config file if needed.
                       With --write, that file is changed to run the gateway
                       in place of the imported servers (original kept as .bak).
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
  from?: string;
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
    else if (a === "--from" && out.init) out.from = argv[++i];
    else throw new GatewayConfigError(`Unknown argument: ${a}\n\n${USAGE}`);
  }
  return out;
}

async function main(): Promise<void> {
  if (process.argv[2] === "ledger") {
    const r = await runLedgerCommand(process.argv.slice(3));
    console.log(r.stdout);
    process.exitCode = r.exitCode;
    return;
  }
  if (process.argv[2] === "audit") {
    const r = await runAuditCommand(process.argv.slice(3));
    console.log(r.stdout);
    process.exitCode = r.exitCode;
    return;
  }
  if (process.argv[2] === "playground") return runPlayground(process.argv.slice(3));
  if (process.argv[2] === "receipt" || process.argv[2] === "key") {
    const r = process.argv[2] === "key" ? await runKeyCommand() : await runReceiptCommand(process.argv.slice(3));
    console.log(r.stdout);
    process.exitCode = r.exitCode;
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  // --help and --version print to stdout and exit; MCP is never served in these modes.
  if (args.help) return void console.log(USAGE);
  if (args.version) return void console.log(GATEWAY_VERSION);
  if (!args.config) throw new GatewayConfigError(`Missing --config\n\n${USAGE}`);
  if (args.init) return init(args.config, args.write === true, args.from);
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
  const lines: string[] = [];
  if (r.mcp) {
    const m = r.mcp;
    for (const i of m.imported) lines.push(`  imported ${i.name}${i.id !== i.name ? ` as ${i.id}` : ""} from ${m.path}`);
    for (const k of m.kept) lines.push(`  ${k.name}: already in the config as ${k.id}, kept as it is`);
    for (const s of m.skipped) lines.push(`  ${s.name}: left in ${m.path} (${s.reason})`);
    if (!m.imported.length && !m.kept.length) lines.push(`  nothing to import from ${m.path}`);
  }
  if (r.created) lines.push(`  ${write ? "created" : "would create"} ${path}`);
  lines.push(...r.reports.map((s) => {
    const parts = [`${s.added.length} tools added`];
    if (s.kept.length) parts.push(`${s.kept.length} kept`);
    if (s.addedDefaults) parts.push("defaults added");
    if (s.stale.length) parts.push(`no longer offered: ${s.stale.join(", ")}`);
    return `  ${s.id} (${s.preset ? `preset ${s.preset}` : "from tool hints, review"}): ${parts.join("; ")}`;
  }));
  for (const f of r.failed) lines.push(`  ${f.id}: could not connect, skipped (${f.error})`);
  const changed = r.created || r.mcp?.changed || r.reports.some((s) => s.added.length || s.addedDefaults);
  let tail: string;
  if (!changed) tail = "Nothing to add.";
  else if (!write) tail = "Nothing written. Review the config above, then re-run with --write.";
  else {
    tail = r.created ? `Wrote ${path}.` : `Updated ${path} (original saved as ${path}.bak).`;
    if (r.mcp?.changed) tail += ` ${r.mcp.path} now runs the gateway (original saved as ${r.mcp.path}.bak); restart your MCP client.`;
    tail += ' Review every line marked "review".';
  }
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

async function init(path: string, write: boolean, from?: string): Promise<void> {
  const result = await runInit({ path, write, ...(from ? { from } : {}) });
  if (!write) {
    process.stdout.write(result.text);
    if (result.mcp?.changed) process.stdout.write(`\n# ${result.mcp.path} with --write:\n${result.mcp.text.replace(/^/gm, "# ")}\n`);
  }
  console.error(`[adtl-gateway] init\n${summarize(result, path, write)}`);
  if (result.failed.length && !result.reports.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  const known = err instanceof GatewayConfigError || err instanceof EnvExpansionError || ["ledger", "audit", "receipt", "key", "playground"].includes(process.argv[2] ?? "");
  console.error(known ? `[adtl-gateway] ${(err as Error).message}` : err);
  // For Claude Code hooks only exit code 2 stops the call; any other code lets it run.
  process.exit(process.argv[2] === "hook" ? 2 : 1);
});
