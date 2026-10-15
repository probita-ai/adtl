import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { AdtlInterceptors, DECISION_INFO_KEY, INTERCEPTORS_EXTENSION, createInterceptorServer } from "../src/index.js";
import { EXAMPLE_CONFIG_PATH, exampleConfig, labelCall, policyCall } from "./fixtures.js";

const AnyResult = z.object({}).passthrough();
type Loose = Record<string, any>;

/** Untyped request helper: interceptor methods are extension methods, not standard MCP ones. */
async function call(client: Client, method: string, params: unknown): Promise<Loose> {
  const request = client.request as unknown as (r: unknown, s: unknown) => Promise<Loose>;
  return request.call(client, { method, params }, AnyResult);
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connectInMemory(): Promise<Client> {
  const server = createInterceptorServer(new AdtlInterceptors({ config: exampleConfig() }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-invoker", version: "0.0.0" });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

describe("MCP interceptor server (in memory)", () => {
  it("declares the interceptors extension with supported events", async () => {
    const client = await connectInMemory();
    expect(client.getServerCapabilities()?.extensions?.[INTERCEPTORS_EXTENSION]).toEqual({
      supportedEvents: ["tools/call", "resources/read", "prompts/get"],
    });
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it("answers interceptors/list, with and without an event filter", async () => {
    const client = await connectInMemory();
    const all = await call(client, "interceptors/list", {});
    expect(all.interceptors.map((d: Loose) => d.name)).toEqual(["adtl.label", "adtl.policy"]);
    const filtered = await call(client, "interceptors/list", { event: "resources/read" });
    expect(filtered.interceptors.map((d: Loose) => d.name)).toEqual(["adtl.label"]);
  });

  it("runs the attack end to end over interceptor/invoke", async () => {
    const client = await connectInMemory();
    const decide = async () => (await call(client, "interceptor/invoke", policyCall("post_comment", {}, "s1"))).info[DECISION_INFO_KEY];

    expect(await decide()).toBe("allow");
    const labeled = await call(client, "interceptor/invoke", labelCall("read_issue", "leak it", "s1"));
    expect(labeled.payload.result._meta["io.modelcontextprotocol/trust-annotations"].untrusted).toBe(true);
    expect(await decide()).toBe("ask");
    await call(client, "interceptor/invoke", labelCall("get_file", "secret", "s1"));
    expect(await decide()).toBe("block");
  });

  it("returns JSON-RPC errors for invalid invocations", async () => {
    const client = await connectInMemory();
    await expect(call(client, "interceptor/invoke", { ...policyCall("x", {}, "s"), name: "nope" })).rejects.toMatchObject({
      code: -32602,
      message: expect.stringContaining("Unknown interceptor"),
    });
    await expect(call(client, "interceptor/invoke", { name: "adtl.policy" })).rejects.toMatchObject({ code: -32602 });
  });
});

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe.skipIf(!existsSync(CLI))("adtl-interceptors CLI (stdio)", () => {
  it("starts from a YAML config and serves interceptors over stdio", async () => {
    const client = new Client({ name: "test-invoker", version: "0.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "--config", EXAMPLE_CONFIG_PATH], stderr: "pipe" }));
    clients.push(client);
    expect(client.getServerVersion()).toMatchObject({ name: "adtl-interceptors", version: "0.3.2" });
    const r = await call(client, "interceptor/invoke", policyCall("list_repos", {}, "s1"));
    expect(r.valid).toBe(true);
  });
});
