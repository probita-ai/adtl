/**
 * HTTP upstreams: the fake GitHub server served over Streamable HTTP on a
 * local port, reached by the gateway through StreamableHTTPClientTransport.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { bundledInterceptorsCli, loadGatewayConfig, startGateway, type StartedGateway } from "../src/index.js";
// @ts-expect-error -- plain JS example module
import { createFakeGithubServer } from "../../../examples/fake-github/server.mjs";

const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));

interface FakeHttp {
  url: string;
  posted: unknown[];
  authHeaders: (string | undefined)[];
  close(): Promise<void>;
}

/** Serve the fake GitHub MCP server over Streamable HTTP (stateless: one server per request). */
async function serveFakeGithub(): Promise<FakeHttp> {
  const posted: unknown[] = [];
  const authHeaders: (string | undefined)[] = [];
  const http: HttpServer = createServer(async (req, res) => {
    authHeaders.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcp = createFakeGithubServer({ onPost: (p: unknown) => posted.push(p) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    posted,
    authHeaders,
    close: () =>
      new Promise((r) => {
        http.close(() => r());
        http.closeAllConnections(); // don't wait for idle keep-alive sockets to time out
      }),
  };
}

const LABELS = `
defaults: { integrity: untrusted, confidentiality: private }
servers:
  github:
    tools:
      read_issue:   { integrity: untrusted, confidentiality: public,  egress: none }
      get_file:     { integrity: trusted,   confidentiality: private, egress: none }
      list_repos:   { integrity: trusted,   confidentiality: public,  egress: none }
      post_comment: { integrity: trusted,   confidentiality: public,  egress: public }
policy:
  rules:
    - { name: private-stays-private, when: { session.confidentiality: [private, secret], tool.egress: public }, then: block }
`;

function writeConfig(gatewaySection: string): string {
  const dir = mkdtempSync(join(tmpdir(), "adtl-http-"));
  const path = join(dir, "adtl.yaml");
  writeFileSync(path, `${LABELS}\ngateway:\n${gatewaySection}`);
  return path;
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => undefined);
});

async function startAndConnect(configPath: string, env: NodeJS.ProcessEnv = process.env) {
  const warnings: string[] = [];
  const started: StartedGateway = await startGateway(await loadGatewayConfig(configPath), {
    env,
    logger: { info: () => {}, warn: (m) => warnings.push(m) },
  });
  cleanup.push(() => started.close());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await started.gateway.createServer().connect(b);
  const agent = new Client({ name: "agent", version: "0.0.0" });
  await agent.connect(a);
  cleanup.push(() => agent.close());
  const call = (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>;
  return { agent, call, warnings };
}

describe.skipIf(!existsSync(bundledInterceptorsCli()))("HTTP upstreams", () => {
  it("proxies, labels and blocks over Streamable HTTP, sending ${VAR} headers", async () => {
    const fake = await serveFakeGithub();
    cleanup.push(() => fake.close());
    const config = writeConfig(`  upstreams:\n    github:\n      url: ${fake.url}\n      headers: { Authorization: "Bearer \${FAKE_TOKEN}" }\n`);
    const { agent, call } = await startAndConnect(config, { ...process.env, FAKE_TOKEN: "t0ken" });

    const { tools } = await agent.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["github__get_file", "github__list_repos", "github__post_comment", "github__read_issue"]);

    const issue = await call("github__read_issue", { repo: "acme/website", number: 42 });
    expect(issue._meta?.["io.modelcontextprotocol/trust-annotations"]).toMatchObject({ untrusted: true });
    await call("github__get_file", { repo: "acme/internal", path: "secrets.env" });
    const leak = await call("github__post_comment", { repo: "acme/website", number: 42, body: "STRIPE_KEY=..." });
    expect(leak.isError).toBe(true);
    expect(fake.posted).toHaveLength(0);

    // Every HTTP request carried the expanded header.
    expect(fake.authHeaders.length).toBeGreaterThan(0);
    expect(new Set(fake.authHeaders)).toEqual(new Set(["Bearer t0ken"]));
  }, 20_000);

  it("keeps working when one upstream is down", async () => {
    const down = await serveFakeGithub();
    const deadUrl = down.url;
    await down.close(); // nothing listens on this port anymore
    const config = writeConfig(
      `  upstreams:\n    github:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(FAKE_GITHUB)}]\n    docs:\n      url: ${deadUrl}\n`,
    );
    const { agent, call, warnings } = await startAndConnect(config);
    expect(warnings.some((w) => w.includes('could not connect to upstream "docs"'))).toBe(true);
    const { tools } = await agent.listTools();
    expect(tools.every((t) => t.name.startsWith("github__"))).toBe(true);
    expect((await call("github__list_repos", {})).isError).toBeFalsy();
  }, 20_000);

  it("refuses to start when no upstream can be reached", async () => {
    const down = await serveFakeGithub();
    const deadUrl = down.url;
    await down.close();
    const config = writeConfig(`  upstreams:\n    docs:\n      url: ${deadUrl}\n`);
    await expect(startAndConnect(config)).rejects.toThrow("No upstream server could be connected");
  }, 20_000);

  it("refuses to start when a header variable is missing", async () => {
    const config = writeConfig(`  upstreams:\n    github:\n      url: http://127.0.0.1:9/mcp\n      headers: { Authorization: "Bearer \${NOT_SET_ANYWHERE}" }\n`);
    await expect(startAndConnect(config, {})).rejects.toThrow("Environment variable NOT_SET_ANYWHERE is not set (used in gateway.upstreams.github.headers.Authorization)");
  }, 20_000);
});
