import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvExpansionError, expandEnv, expandUpstream, loadGatewayConfig } from "../src/index.js";

function writeConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "adtl-gw-"));
  const path = join(dir, "adtl.yaml");
  writeFileSync(path, yaml);
  return path;
}

describe("expandEnv", () => {
  it("replaces ${VAR}, keeps $${VAR} literal, and names missing variables", () => {
    expect(expandEnv("Bearer ${TOKEN}", { TOKEN: "abc" }, "x")).toBe("Bearer abc");
    expect(expandEnv("$${TOKEN}", {}, "x")).toBe("${TOKEN}");
    expect(() => expandEnv("${NOPE}", {}, "gateway.upstreams.github.env.GITHUB_TOKEN")).toThrow(EnvExpansionError);
    expect(() => expandEnv("${NOPE}", {}, "where")).toThrow("Environment variable NOPE is not set (used in where)");
  });

  it("expands stdio and http upstreams", () => {
    const env = { T: "tok", H: "host" };
    expect(expandUpstream("gh", { command: "npx", args: ["--token=${T}"], env: { A: "${T}" } }, env)).toEqual({
      command: "npx",
      args: ["--token=tok"],
      env: { A: "tok" },
    });
    expect(expandUpstream("web", { url: "https://${H}/mcp", headers: { Authorization: "Bearer ${T}" } }, env)).toEqual({
      url: "https://host/mcp",
      headers: { Authorization: "Bearer tok" },
    });
  });
});

describe("loadGatewayConfig", () => {
  it("loads labels and gateway settings from one file", async () => {
    const c = await loadGatewayConfig(
      writeConfig(`
servers: { github: { tools: { read_issue: { integrity: untrusted } } } }
gateway:
  audit: logs/audit.jsonl
  upstreams:
    github: { command: node, args: [server.mjs] }
    docs: { url: "https://example.com/mcp" }
`),
    );
    expect(Object.keys(c.labels.servers)).toEqual(["github"]);
    expect(c.gateway.upstreams.github).toEqual({ command: "node", args: ["server.mjs"], env: {} });
    expect(c.gateway.upstreams.docs).toEqual({ url: "https://example.com/mcp", headers: {} });
    expect(c.gateway.interceptorTimeoutMs).toBe(5000);
    expect(c.gateway.mode).toBe("active");
  });

  it("accepts mode: audit and rejects other modes", async () => {
    const c = await loadGatewayConfig(writeConfig("gateway: { mode: audit, upstreams: { a: { command: x } } }\n"));
    expect(c.gateway.mode).toBe("audit");
    await expect(loadGatewayConfig(writeConfig("gateway: { mode: off, upstreams: { a: { command: x } } }\n"))).rejects.toThrow(
      /gateway.mode/,
    );
  });

  it("requires a gateway section with at least one upstream", async () => {
    await expect(loadGatewayConfig(writeConfig("servers: {}\n"))).rejects.toThrow(/missing "gateway:" section/);
    await expect(loadGatewayConfig(writeConfig("gateway: { upstreams: {} }\n"))).rejects.toThrow(/At least one upstream/);
  });

  it("rejects upstream ids that would make tool names ambiguous", async () => {
    await expect(loadGatewayConfig(writeConfig("gateway: { upstreams: { my_server: { command: x } } }\n"))).rejects.toThrow(
      /gateway.upstreams: Upstream ids may only contain/,
    );
  });

  it("reports label-config errors and unknown gateway keys", async () => {
    await expect(loadGatewayConfig(writeConfig("defaults: { integrity: maybe }\ngateway: { upstreams: { a: { command: x } } }\n"))).rejects.toThrow(
      /defaults.integrity/,
    );
    await expect(loadGatewayConfig(writeConfig("gateway: { upstreams: { a: { command: x } }, auditt: x }\n"))).rejects.toThrow(
      /Unrecognized key/,
    );
  });

  it("reports a missing file clearly", async () => {
    await expect(loadGatewayConfig("/nonexistent/adtl.yaml")).rejects.toThrow(/Cannot read config file/);
  });
});
