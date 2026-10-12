import { describe, expect, it } from "vitest";
import { ConfigError, loadConfigFile, parseConfigText } from "../src/loadConfig.js";
import { EXAMPLE_CONFIG_PATH } from "./fixtures.js";

describe("config loading", () => {
  it("loads the example YAML", async () => {
    const c = await loadConfigFile(EXAMPLE_CONFIG_PATH);
    expect(Object.keys(c.servers)).toEqual(["github"]);
    expect(c.policy.rules.map((r) => r.name)).toEqual(["no-public-write-after-untrusted", "private-stays-private"]);
  });

  it("accepts JSON and an empty file", () => {
    expect(parseConfigText('{"defaults":{"integrity":"trusted","confidentiality":"public"}}').defaults.integrity).toBe("trusted");
    expect(parseConfigText("").defaults).toEqual({ integrity: "untrusted", confidentiality: "private" });
  });

  it("reports every problem with its path", () => {
    let err: unknown;
    try {
      parseConfigText("servers:\n  github:\n    tools:\n      read_issue: { integrity: maybe }\npolicy:\n  default: sometimes\n", "adtl.yaml");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("adtl.yaml: invalid ADTL config");
    expect((err as Error).message).toContain("servers.github.tools.read_issue.integrity");
    expect((err as Error).message).toContain("policy.default");
  });

  it("reports YAML syntax errors and missing files", async () => {
    expect(() => parseConfigText("servers: [unclosed", "bad.yaml")).toThrow(/bad.yaml: invalid YAML/);
    await expect(loadConfigFile("/nonexistent/adtl.yaml")).rejects.toThrow(/Cannot read config file/);
  });
});
