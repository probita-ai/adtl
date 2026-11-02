import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadGatewayConfig, startGateway } from "../src/index.js";

const EXAMPLE = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));
const THIRD_PARTY = fileURLToPath(new URL("./fixtures/third-party-interceptors.mjs", import.meta.url));

function writeConfig(gateway: string): string {
  const dir = mkdtempSync(join(tmpdir(), "adtl-ics-"));
  const path = join(dir, "adtl.yaml");
  const labels = readFileSync(EXAMPLE, "utf8").replace(/gateway:[\s\S]*$/, "");
  writeFileSync(path, `${labels}gateway:\n  upstreams:\n    github: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(FAKE_GITHUB)}] }\n${gateway}`);
  return path;
}

const thirdParty = (...flags: string[]) =>
  `  interceptorServers:\n    acme: { command: ${JSON.stringify(process.execPath)}, args: ${JSON.stringify([THIRD_PARTY, ...flags])} }\n`;

const text = (r: CallToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");

describe("gateway.interceptorServers", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((f) => f()));
  });

  async function start(gateway: string) {
    const warnings: string[] = [];
    const info: string[] = [];
    const started = await startGateway(await loadGatewayConfig(writeConfig(gateway)), {
      env: process.env,
      logger: { info: (m) => info.push(m), warn: (m) => warnings.push(m) },
    });
    cleanup.push(() => started.close());
    const [a, b] = InMemoryTransport.createLinkedPair();
    await started.gateway.createServer().connect(b);
    const agent = new Client({ name: "agent", version: "0.0.0" });
    await agent.connect(a);
    cleanup.push(() => agent.close());
    return { call: (name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<CallToolResult>, warnings, info };
  }

  it("runs another server's interceptors beside ADTL's, each on its own server", async () => {
    const { call, info, warnings } = await start(thirdParty());
    expect(info.find((m) => m.startsWith("interceptors:"))).toMatch(/adtl\.label.*redact\.private.*deny\.comments|redact\.private/);
    const listed = await call("github__list_repos", {});
    expect(text(listed)).toContain("acme/internal ([redacted])");
    // ADTL still labels the (redacted) result, because it runs after the third-party mutator.
    expect(listed._meta?.["io.modelcontextprotocol/trust-annotations"]).toBeDefined();
    const denied = await call("github__post_comment", { repo: "acme/website", number: 1, body: "hi" });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("third party says no comments");
    expect(warnings).toEqual([]);
  });

  it("warns when another server's mutator would run after adtl.label", async () => {
    const { warnings } = await start(thirdParty("--late"));
    expect(warnings.join("\n")).toMatch(/redact\.private run after adtl\.label/);
  });

  it("refuses duplicate interceptor names and unreachable servers", async () => {
    await expect(start(thirdParty("--name-clash"))).rejects.toThrow(/unique across servers: adtl\.label \(offered by interceptors, acme\)/);
    await expect(start("  interceptorServers:\n    gone: { url: http://127.0.0.1:9/mcp }\n")).rejects.toThrow(/gateway\.interceptorServers\.gone: could not connect/);
  });
});
