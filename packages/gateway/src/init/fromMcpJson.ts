/**
 * `adtl-gateway init --from .mcp.json`: import an MCP client's server list
 * (Claude Code's .mcp.json, or any file with `mcpServers`, such as Claude
 * Desktop's config) into `gateway.upstreams`, and point the client at the
 * gateway instead.
 *
 * - stdio servers keep their command, args and env; HTTP servers their url
 *   and headers. `${VAR}` and `${VAR:-default}` work the same in adtl.yaml.
 * - SSE servers are left in the client config: the gateway speaks Streamable HTTP only.
 * - An entry that already runs the gateway is recognized and kept.
 * - Upstreams already in adtl.yaml are never changed.
 *
 * The new client config has the imported servers replaced by one entry that
 * runs the gateway; everything else in the file is kept.
 */
import { dirname, relative, resolve } from "node:path";
import { isMap, type Document } from "yaml";
import type { Upstream } from "../config.js";
import { GATEWAY_VERSION } from "../gateway.js";

export const DEFAULT_GATEWAY_NAME = "adtl";

export interface McpImport {
  /** Servers moved into gateway.upstreams: name in the client config → upstream id. */
  imported: { name: string; id: string }[];
  /** Servers already in adtl.yaml under the same id; left as they are. */
  kept: { name: string; id: string }[];
  /** Servers left in the client config, with why. */
  skipped: { name: string; reason: string }[];
  /** The client config as it should be once the gateway replaces the imported servers. */
  text: string;
  changed: boolean;
}

type Entry = Record<string, unknown>;

function isRecord(v: unknown): v is Entry {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  return Object.values(v).every((x) => typeof x === "string") ? (v as Record<string, string>) : undefined;
}

/** True if this client entry already runs adtl-gateway. */
export function isGatewayEntry(entry: Entry): boolean {
  const words = [entry.command, ...(strings(entry.args) ?? [])].filter((w): w is string => typeof w === "string");
  return words.some((w) => /(^|[/\\@])adtl-gateway$|@adtl\/gateway(@[^/\s]*)?$|packages[/\\]gateway[/\\]dist[/\\]cli\.js$/.test(w));
}

/** A valid upstream id (letters, digits, '-') for a client server name, unique among `taken`. */
export function upstreamId(name: string, taken: Set<string>): string {
  const base = name.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/** The upstream for one client entry, or why it can't be one. */
export function toUpstream(entry: Entry, mcpDir: string, configDir: string): Upstream | { skip: string } {
  const type = typeof entry.type === "string" ? entry.type : undefined;
  if (type === "sse") return { skip: "the gateway doesn't support SSE servers; it speaks Streamable HTTP" };
  if (type === "http" || (type === undefined && typeof entry.url === "string")) {
    if (typeof entry.url !== "string") return { skip: "HTTP server without a url" };
    const headers = stringRecord(entry.headers);
    return { url: entry.url, headers: headers ?? {} };
  }
  if (type !== undefined && type !== "stdio") return { skip: `unknown server type "${type}"` };
  if (typeof entry.command !== "string" || entry.command === "") return { skip: "no command or url" };
  // Clients start stdio servers in the project directory; the gateway resolves cwd against adtl.yaml's.
  const cwd = relative(configDir, mcpDir);
  const args = strings(entry.args) ?? [];
  const env = stringRecord(entry.env) ?? {};
  return {
    command: entry.command,
    args,
    env,
    ...(cwd !== "" ? { cwd } : {}),
  };
}

/** What runs the gateway from the client config, with adtl.yaml given relative to the client config's directory. */
export function gatewayEntry(configPath: string, mcpDir: string): Entry {
  return { command: "npx", args: ["-y", `@adtl/gateway@${GATEWAY_VERSION}`, "--config", relative(mcpDir, configPath) || configPath] };
}

/**
 * Add the client's servers to `doc` (adtl.yaml) under gateway.upstreams, and
 * return the client config rewritten to use the gateway.
 */
export function importMcpServers(
  mcpText: string,
  mcpPath: string,
  doc: Document,
  configPath: string,
  gatewayName = DEFAULT_GATEWAY_NAME,
): McpImport {
  let json: unknown;
  try {
    json = JSON.parse(mcpText);
  } catch (err) {
    throw new Error(`${mcpPath}: not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(json) || !isRecord(json.mcpServers)) throw new Error(`${mcpPath}: no "mcpServers" object`);

  const mcpDir = dirname(resolve(mcpPath));
  const configDir = dirname(resolve(configPath));
  const existing = doc.getIn(["gateway", "upstreams"]);
  const taken = new Set<string>(isMap(existing) ? existing.items.map((p) => String((p.key as { value?: unknown })?.value ?? p.key)) : []);
  const alreadyThere = new Set(taken);

  const result: McpImport = { imported: [], kept: [], skipped: [], text: mcpText, changed: false };
  const servers: Record<string, unknown> = {};
  let gatewayKey: string | undefined;

  for (const [name, entry] of Object.entries(json.mcpServers)) {
    if (!isRecord(entry)) {
      result.skipped.push({ name, reason: "not an object" });
      servers[name] = entry;
      continue;
    }
    if (isGatewayEntry(entry)) {
      gatewayKey ??= name;
      servers[name] = entry;
      continue;
    }
    const upstream = toUpstream(entry, mcpDir, configDir);
    if ("skip" in upstream) {
      result.skipped.push({ name, reason: upstream.skip });
      servers[name] = entry;
      continue;
    }
    const plain = name.replace(/[^A-Za-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
    if (alreadyThere.has(plain)) {
      result.kept.push({ name, id: plain });
      continue;
    }
    const id = upstreamId(name, taken);
    // Leave out empty fields; the gateway fills them in.
    const written = Object.fromEntries(
      Object.entries(upstream).filter(([, v]) => !(Array.isArray(v) ? v.length === 0 : isRecord(v) && Object.keys(v).length === 0)),
    );
    doc.setIn(["gateway", "upstreams", id], doc.createNode(written));
    result.imported.push({ name, id });
  }
  // Block style, so long paths and secrets references stay readable (a new config starts with `upstreams: {}`).
  const upstreams = doc.getIn(["gateway", "upstreams"]);
  if (isMap(upstreams) && result.imported.length) upstreams.flow = false;

  if (result.imported.length === 0 && result.kept.length === 0) return result;
  if (gatewayKey === undefined) {
    let key = gatewayName;
    for (let n = 2; key in servers; n++) key = `${gatewayName}-${n}`;
    servers[key] = gatewayEntry(resolve(configPath), mcpDir);
  }
  result.text = `${JSON.stringify({ ...json, mcpServers: servers }, null, 2)}\n`;
  result.changed = result.text !== mcpText;
  return result;
}
