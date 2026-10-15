/**
 * `adtl-gateway init`: connect to every upstream in adtl.yaml, list its
 * tools, and draft a labeling rule for each tool not configured yet.
 *
 * With `from` (e.g. `.mcp.json`), the client's MCP servers are first imported
 * into gateway.upstreams (see fromMcpJson.ts), and adtl.yaml is created if it
 * doesn't exist yet.
 *
 * Without `write`, the updated file is only returned (the CLI prints it).
 * With `write`, the original is kept as `<file>.bak` and the file is updated
 * in place; with `from`, the client config is rewritten to use the gateway,
 * also keeping a `.bak`. Existing entries and comments are never changed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseDocument } from "yaml";
import { expandUpstream } from "../config.js";
import { GatewayConfigError, connectUpstream, parseGatewayConfigText } from "../startup.js";
import { importMcpServers, type McpImport } from "./fromMcpJson.js";
import { mergeIntoDocument, suggest, type MergeReport, type ServerScan } from "./suggest.js";

export interface InitOptions {
  path: string;
  write?: boolean;
  env?: NodeJS.ProcessEnv;
  /** An MCP client config with `mcpServers` (e.g. Claude Code's .mcp.json) to import upstreams from. */
  from?: string;
  /** Name for the gateway's entry in that client config. Default `adtl`. */
  gatewayName?: string;
}

/** Don't fold long values (paths, commands) across lines. */
const YAML_OPTIONS = { lineWidth: 0 } as const;

/** Starting point when `--from` creates adtl.yaml. */
export const NEW_CONFIG = `# ADTL config, drafted by \`adtl-gateway init --from\`. Review every rule marked "review".
#
# For every tool, say what its result is (integrity, confidentiality) and where
# calling it can send data (egress). Anything left out gets the defaults below.

defaults:
  integrity: untrusted
  confidentiality: private

policy:
  default: allow
  rules:
    - name: no-public-write-after-untrusted
      when:
        session.integrity: untrusted
        tool.egress: [public, external, unknown]
      then: ask
      reason: Session has read untrusted content; confirm before sending data out

    - name: private-stays-private
      when:
        session.confidentiality: [private, secret]
        tool.egress: public
      then: block
      reason: Private data must not reach a public tool

gateway:
  upstreams: {}
`;

export interface InitResult {
  /** The updated adtl.yaml. */
  text: string;
  reports: MergeReport[];
  /** Upstreams that could not be scanned; left untouched in the file. */
  failed: { id: string; error: string }[];
  /** With `from`: what was imported, and the rewritten client config. */
  mcp?: McpImport & { path: string };
  /** True if adtl.yaml didn't exist and was drafted from scratch. */
  created?: boolean;
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function scan(id: string, connect: () => Promise<Client>): Promise<ServerScan> {
  const client = await connect();
  try {
    const name = client.getServerVersion()?.name;
    const tools = await listAllTools(client);
    return { id, ...(name ? { serverName: name } : {}), tools: tools.map((t) => ({ name: t.name, annotations: t.annotations })) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const env = opts.env ?? process.env;
  const path = resolve(opts.path);
  let original: string | undefined;
  try {
    original = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || !opts.from) {
      throw new GatewayConfigError(`Cannot read config file ${path}: ${(err as Error).message}`);
    }
  }
  const doc = parseDocument(original ?? NEW_CONFIG);

  let mcp: InitResult["mcp"];
  if (opts.from) {
    const mcpPath = resolve(opts.from);
    let mcpText: string;
    try {
      mcpText = await readFile(mcpPath, "utf8");
    } catch (err) {
      throw new GatewayConfigError(`Cannot read ${mcpPath}: ${(err as Error).message}`);
    }
    try {
      mcp = { path: mcpPath, ...importMcpServers(mcpText, mcpPath, doc, path, opts.gatewayName) };
    } catch (err) {
      throw new GatewayConfigError((err as Error).message);
    }
  }

  const loaded = parseGatewayConfigText(doc.toString(YAML_OPTIONS), path);
  const baseDir = dirname(loaded.path);
  const ids = Object.keys(loaded.gateway.upstreams);
  const settled = await Promise.allSettled(
    ids.map((id) => scan(id, () => connectUpstream(id, expandUpstream(id, loaded.gateway.upstreams[id]!, env), baseDir))),
  );
  const scans: ServerScan[] = [];
  const failed: InitResult["failed"] = [];
  settled.forEach((s, i) => {
    if (s.status === "fulfilled") scans.push(s.value);
    else failed.push({ id: ids[i]!, error: (s.reason as Error).message });
  });

  const reports = mergeIntoDocument(doc, scans.map((s) => suggest(s)));
  const text = doc.toString(YAML_OPTIONS);
  if (opts.write) {
    if (original === undefined) await writeFile(path, text, "utf8");
    else if (text !== original) {
      await writeFile(`${path}.bak`, original, "utf8");
      await writeFile(path, text, "utf8");
    }
    if (mcp?.changed) {
      await writeFile(`${mcp.path}.bak`, await readFile(mcp.path, "utf8"), "utf8");
      await writeFile(mcp.path, mcp.text, "utf8");
    }
  }
  return { text, reports, failed, ...(mcp ? { mcp } : {}), ...(original === undefined ? { created: true } : {}) };
}
