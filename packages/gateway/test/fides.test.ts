import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AdtlInterceptors, createInterceptorServer } from "@adtl/interceptors";
import { parseConfig } from "@adtl/labels";
import { AdtlGateway, InterceptorInvoker } from "../src/index.js";

const FIDES = "com.github.ifc/labels";
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

describe("fides-gateway interop through the gateway", () => {
  it("sends the session's label to the upstream in the call's _meta, and reads fides-gateway labels back", async () => {
    const received: unknown[] = [];
    // Stands in for a server behind fides-gateway: it reads our label and labels its own result.
    const upstream = new McpServer({ name: "work", version: "0.0.0" });
    upstream.registerTool("read_mail", { description: "Read mail" }, async (extra) => {
      received.push(extra._meta?.[FIDES]);
      return { content: [{ type: "text", text: "salary review" }], _meta: { [FIDES]: { $: { integrity: "untrusted", confidentiality: ["alice"] } } } };
    });
    const config = parseConfig({
      defaults: { integrity: "trusted", confidentiality: "public" },
      servers: { work: { defaults: { egress: "none" } } },
      fides: { emit: true },
    });
    const gateway = new AdtlGateway({
      upstreams: new Map([["work", await linked(upstream, "gw→work")]]),
      invoker: new InterceptorInvoker(await InterceptorInvoker.discover(await linked(createInterceptorServer(new AdtlInterceptors({ config })), "gw→ic")), 5000),
      sessionId: "s1",
      principal: { type: "user", id: "alice" },
      logger: { info: () => {}, warn: () => {} },
    });
    const agent = await linked(gateway.createServer(), "agent");
    const call = () => agent.callTool({ name: "work__read_mail", arguments: {} }) as Promise<CallToolResult>;

    const first = await call();
    expect(received[0]).toEqual({ $: { integrity: "trusted", confidentiality: ["public"] } });
    expect(first._meta?.["io.modelcontextprotocol/trust-annotations"]).toMatchObject({ untrusted: true, sensitive: true });
    expect(first._meta?.[FIDES]).toEqual({ $: { integrity: "untrusted", confidentiality: ["alice"] } });

    await call();
    // The second call carries what the session has seen since: untrusted, readable by alice only.
    expect(received[1]).toEqual({ $: { integrity: "untrusted", confidentiality: ["alice"] } });
  });
});
