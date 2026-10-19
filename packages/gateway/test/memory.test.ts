/**
 * Written Monday, read Tuesday, through a memory server.
 *
 * The ledger recognizes text by its hashes, so it only follows the label when
 * the memory server returns the text the session sent. Servers that extract
 * facts with a model on write, or consolidate records, return text that
 * matches nothing, and the read falls back to the tool's own (trusted) rule.
 *
 * The `it.fails` tests document that gap: they pass while the gap is open and
 * start failing once the label travels with the record, at which point they
 * become plain `it` tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AdtlInterceptors, createInterceptorServer, parseConfigText } from "@adtl/interceptors";
import { Ledger } from "@adtl/ledger";
import { AdtlGateway, InterceptorInvoker, MemoryAuditLog } from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer, INJECTED_ISSUE } from "../../../examples/fake-github/server.mjs";
// @ts-expect-error -- plain JS example module
import { createFakeMemoryServer } from "../../../examples/fake-memory/server.mjs";

const CONFIG = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));

// Reading your own memories is trusted, like reading your own notes.
const MEMORY_SERVER = `servers:
  memory:
    tools:
      add_memory:    { integrity: trusted, confidentiality: public, egress: internal }
      search_memory: { integrity: trusted, confidentiality: public, egress: none }
      consolidate:   { integrity: trusted, confidentiality: public, egress: internal }
`;

const toClose: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.allSettled(toClose.splice(0).map((c) => c.close()));
});

async function linked(server: { connect(t: unknown): Promise<void> }, name: string): Promise<Client> {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name, version: "0.0.0" });
  await client.connect(a);
  toClose.push(client);
  return client;
}

/** One interceptor core, ledger and memory store; one gateway per session, as with separate agent sessions. */
function world() {
  const config = parseConfigText(readFileSync(CONFIG, "utf8").replace("servers:\n", MEMORY_SERVER));
  const ledger = new Ledger(join(mkdtempSync(join(tmpdir(), "adtl-memory-")), "ledger.db"));
  const core = new AdtlInterceptors({ config, ledger });
  const memories: unknown[] = [];
  const audit = new MemoryAuditLog();

  async function session(sessionId: string) {
    const gateway = new AdtlGateway({
      upstreams: new Map([
        ["github", await linked(createFakeGithubServer(), "gw→github")],
        ["memory", await linked(createFakeMemoryServer({ memories }), "gw→memory")],
      ]),
      invoker: new InterceptorInvoker(await InterceptorInvoker.discover(await linked(createInterceptorServer(core), "gw→interceptors")), 5000),
      sessionId,
      audit,
      logger: { info: () => {}, warn: () => {} },
    });
    const agent = await linked(gateway.createServer(), "agent");
    return (name: string, args: Record<string, unknown> = {}) => agent.callTool({ name, arguments: args });
  }

  /** Monday: read the injected issue, then save it to memory. */
  async function monday(addArgs: Record<string, unknown>) {
    const call = await session("mon");
    await call("github__read_issue", { repo: "acme/website", number: 42 });
    await call("memory__add_memory", { text: INJECTED_ISSUE, ...addArgs });
    return call;
  }

  /** Tuesday: a fresh session reads its memories. Returns the audit entry for that read. */
  async function tuesday() {
    const call = await session("tue");
    await call("memory__search_memory", { query: "release" });
    return audit.entries.at(-1)!;
  }

  return { monday, tuesday };
}

describe("ledger through a memory server: written Monday, read Tuesday", () => {
  it("follows the label when the server stores the text as sent (infer: false)", async () => {
    const w = world();
    await w.monday({ infer: false });
    expect(await w.tuesday()).toMatchObject({ label: { integrity: "untrusted" }, ledger: { writers: ["mon"] } });
  });

  // Known gap: extracted facts match no recorded hash, so the read comes back trusted.
  it.fails("follows the label when the server extracts facts on write (infer defaults to true)", async () => {
    const w = world();
    await w.monday({});
    expect(await w.tuesday()).toMatchObject({ label: { integrity: "untrusted" }, ledger: { writers: ["mon"] } });
  });

  // Known gap: the merged record matches nothing, though its strictest input was tainted.
  it.fails("keeps the strictest label when the server consolidates records", async () => {
    const w = world();
    const mon = await w.monday({ infer: false });
    await mon("memory__add_memory", { text: "The release checklist lives in docs/release.md", infer: false });
    await mon("memory__consolidate");
    expect(await w.tuesday()).toMatchObject({ label: { integrity: "untrusted" }, ledger: { writers: ["mon"] } });
  });
});
