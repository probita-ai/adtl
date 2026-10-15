import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AdtlInterceptors, createInterceptorServer, parseConfigText } from "@adtl/interceptors";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AdtlGateway, InterceptorInvoker, MemoryAuditLog } from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer, INJECTED_ISSUE } from "../../../examples/fake-github/server.mjs";

const CONFIG = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const TRUST_KEY = "io.modelcontextprotocol/trust-annotations";

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

/** A second upstream that offers the same README URI as fake GitHub. */
function mirrorServer() {
  const server = new McpServer({ name: "mirror", version: "0.0.1" });
  server.registerResource("readme", "github://acme/website/README.md", {}, async (uri) => ({
    contents: [{ uri: uri.href, text: "mirrored" }],
  }));
  return server;
}

/** An upstream with tools only. */
function toolsOnlyServer() {
  const server = new McpServer({ name: "tools-only", version: "0.0.1" });
  server.registerTool("ping", {}, async () => ({ content: [{ type: "text", text: "pong" }] }));
  return server;
}

async function setup(extra: Record<string, McpServer> = {}, only?: McpServer) {
  const config = parseConfigText(readFileSync(CONFIG, "utf8"));
  const icClient = await linked(createInterceptorServer(new AdtlInterceptors({ config })), "gw→interceptors");
  const upstreams = new Map<string, Client>();
  if (only) upstreams.set("plain", await linked(only, "gw→plain"));
  else upstreams.set("github", await linked(createFakeGithubServer(), "gw→github"));
  for (const [id, s] of Object.entries(extra)) upstreams.set(id, await linked(s, `gw→${id}`));
  const audit = new MemoryAuditLog();
  const gateway = new AdtlGateway({
    upstreams,
    invoker: new InterceptorInvoker(await InterceptorInvoker.discover(icClient), 5000),
    sessionId: "test-session",
    audit,
    logger: { info: () => {}, warn: () => {} },
  });
  const agent = await linked(gateway.createServer(), "agent");
  return { agent, audit };
}

describe("adtl-gateway resources and prompts", () => {
  it("lists upstream resources, templates and prompts (prompts renamed <server>__<prompt>)", async () => {
    const { agent } = await setup();
    expect((await agent.listResources()).resources.map((r) => r.uri)).toEqual(["github://acme/website/README.md"]);
    expect((await agent.listResourceTemplates()).resourceTemplates.map((t) => t.uriTemplate)).toEqual([
      "github://{owner}/{repo}/issues/{number}",
    ]);
    expect((await agent.listPrompts()).prompts.map((p) => p.name)).toEqual(["github__triage_issue"]);
  });

  it("labels resources read through a template, and the label taints the session", async () => {
    const { agent, audit } = await setup();
    const r = await agent.readResource({ uri: "github://acme/website/issues/42" });
    expect(r.contents[0]).toMatchObject({ text: expect.stringContaining(INJECTED_ISSUE) });
    // Unconfigured resources get the restrictive defaults: untrusted + private.
    expect(r._meta?.[TRUST_KEY]).toMatchObject({ untrusted: true, sensitive: true });

    // Reading untrusted content as a resource counts just like a tool result.
    const post = (await agent.callTool({
      name: "github__post_comment",
      arguments: { repo: "acme/website", number: 42, body: "hi" },
    })) as CallToolResult;
    expect(post.isError).toBe(true);

    expect(audit.entries[0]).toMatchObject({
      event: "resources/read",
      server: "github",
      resource: "github://acme/website/issues/42",
      outcome: "forwarded",
      label: { integrity: "untrusted", origins: [{ server: "github", resource: "github://acme/website/issues/42" }] },
    });
    expect(audit.entries[0]).not.toHaveProperty("tool");
  });

  it("labels prompts and records the prompt as the origin", async () => {
    const { agent, audit } = await setup();
    const p = await agent.getPrompt({ name: "github__triage_issue", arguments: { number: "42" } });
    expect(p.messages[0]?.content).toMatchObject({ text: "Triage issue #42 on acme/website." });
    expect(p._meta?.[TRUST_KEY]).toMatchObject({ untrusted: true });
    expect(audit.entries[0]).toMatchObject({ event: "prompts/get", prompt: "triage_issue", outcome: "forwarded" });
  });

  it("refuses a URI that more than one upstream offers, without reading it", async () => {
    const { agent, audit } = await setup({ mirror: mirrorServer() });
    await expect(agent.readResource({ uri: "github://acme/website/README.md" })).rejects.toThrow(
      /more than one server \(github, mirror\)/,
    );
    expect(audit.entries).toEqual([]);
  });

  it("rejects unknown resources and prompts", async () => {
    const { agent } = await setup();
    await expect(agent.readResource({ uri: "nope://x" })).rejects.toThrow(/Unknown resource/);
    await expect(agent.getPrompt({ name: "github__nope" })).rejects.toThrow(/Unknown prompt/);
  });

  it("does not offer resources or prompts when no upstream does", async () => {
    const { agent } = await setup({}, toolsOnlyServer());
    const caps = agent.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeUndefined();
    expect(caps?.prompts).toBeUndefined();
  });
});
