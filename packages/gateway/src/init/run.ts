/**
 * `adtl-gateway init`: connect to every upstream in adtl.yaml, list its
 * tools, and draft a labeling rule for each tool not configured yet.
 *
 * Without `write`, the updated file is only returned (the CLI prints it).
 * With `write`, the original is kept as `<file>.bak` and the file is updated
 * in place. Existing entries and comments are never changed.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseDocument } from "yaml";
import { expandUpstream } from "../config.js";
import { connectUpstream, loadGatewayConfig } from "../startup.js";
import { mergeIntoDocument, suggest, type MergeReport, type ServerScan } from "./suggest.js";

export interface InitOptions {
  path: string;
  write?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface InitResult {
  /** The updated adtl.yaml. */
  text: string;
  reports: MergeReport[];
  /** Upstreams that could not be scanned; left untouched in the file. */
  failed: { id: string; error: string }[];
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
  const loaded = await loadGatewayConfig(opts.path);
  const baseDir = dirname(loaded.path);
  const original = await readFile(loaded.path, "utf8");

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

  const doc = parseDocument(original);
  const reports = mergeIntoDocument(doc, scans.map((s) => suggest(s)));
  const text = doc.toString();
  if (opts.write && text !== original) {
    await writeFile(`${loaded.path}.bak`, original, "utf8");
    await writeFile(loaded.path, text, "utf8");
  }
  return { text, reports, failed };
}
