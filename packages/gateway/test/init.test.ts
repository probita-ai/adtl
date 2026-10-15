import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseConfigText } from "@adtl/interceptors";
import { parseDocument } from "yaml";
import { choosePreset, mergeIntoDocument, ruleFromHints, runInit, suggest } from "../src/init/index.js";


const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FAKE_GITHUB = fileURLToPath(new URL("../../../examples/fake-github/server.mjs", import.meta.url));

describe("ruleFromHints", () => {
  it("decides egress from readOnlyHint and openWorldHint, using the spec defaults when missing", () => {
    expect(ruleFromHints({ readOnlyHint: true, openWorldHint: false }).rule.egress).toBe("none");
    expect(ruleFromHints({ readOnlyHint: true }).rule.egress).toBe("external");
    expect(ruleFromHints({ openWorldHint: false }).rule.egress).toBe("internal");
    expect(ruleFromHints(undefined).rule.egress).toBe("public");
  });

  it("never trusts a server's own hints for integrity or confidentiality", () => {
    expect(ruleFromHints({ readOnlyHint: true, openWorldHint: false }).rule).toMatchObject({
      integrity: "untrusted",
      confidentiality: "private",
    });
  });
});

describe("presets", () => {
  it("are chosen by the reported server name first, then by upstream id", () => {
    expect(choosePreset("files", "secure-filesystem-server")?.id).toBe("filesystem");
    expect(choosePreset("gh", "github-mcp-server")?.id).toBe("github");
    expect(choosePreset("github", "something-else")?.id).toBe("github");
    expect(choosePreset("mystery", "mystery-server")).toBeUndefined();
  });

  it("split tools into reads and writes by readOnlyHint", () => {
    const s = suggest({
      id: "files",
      serverName: "secure-filesystem-server",
      tools: [
        { name: "read_text_file", annotations: { readOnlyHint: true, openWorldHint: false } },
        { name: "write_file", annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } },
      ],
    });
    expect(s.preset?.id).toBe("filesystem");
    expect(s.tools).toEqual([
      { name: "read_text_file", rule: { integrity: "trusted", confidentiality: "private", egress: "none" }, why: "preset filesystem: read" },
      { name: "write_file", rule: { egress: "internal" }, why: "preset filesystem: write" },
    ]);
  });
});

describe("mergeIntoDocument", () => {
  const scan = {
    id: "github",
    tools: [
      { name: "read_issue", annotations: { readOnlyHint: true } },
      { name: "post_comment", annotations: {} },
    ],
  };

  it("adds missing tools and defaults, keeps existing entries and comments, and reports stale ones", () => {
    const doc = parseDocument(
      "# mine\nservers:\n  github:\n    tools:\n      read_issue: { egress: none } # keep me\n      gone: { egress: none }\n",
    );
    const [report] = mergeIntoDocument(doc, [suggest(scan)]);
    expect(report).toMatchObject({ id: "github", preset: "github", added: ["post_comment"], kept: ["read_issue"], stale: ["gone"], addedDefaults: true });
    const text = doc.toString();
    expect(text).toContain("# mine");
    expect(text).toContain("read_issue: { egress: none } # keep me");
    expect(text).toContain("post_comment: { egress: public } # preset github: write");
    // defaults go first, ahead of tools.
    expect(text.indexOf("defaults:")).toBeLessThan(text.indexOf("tools:"));
    // The result is a valid ADTL config.
    expect(parseConfigText(text).servers.github?.tools.post_comment).toEqual({ egress: "public" });
  });

  it("creates the servers section, ahead of everything else, when there is none", () => {
    const doc = parseDocument("policy:\n  default: allow\n");
    mergeIntoDocument(doc, [suggest({ ...scan, id: "mystery" })]);
    const text = doc.toString();
    expect(text.indexOf("servers:")).toBeLessThan(text.indexOf("policy:"));
    expect(text).toContain("# from MCP tool hints: review every line");
    expect(parseConfigText(text).servers.mystery?.tools.read_issue?.egress).toBe("external");
  });

  it("changes nothing the second time", () => {
    const doc = parseDocument("servers: {}\n");
    mergeIntoDocument(doc, [suggest(scan)]);
    const once = doc.toString();
    const again = parseDocument(once);
    const [report] = mergeIntoDocument(again, [suggest(scan)]);
    expect(report?.added).toEqual([]);
    expect(again.toString()).toBe(once);
  });
});

function tempConfig(): string {
  const dir = mkdtempSync(join(tmpdir(), "adtl-init-"));
  const config = join(dir, "adtl.yaml");
  writeFileSync(
    config,
    `# my config\npolicy:\n  default: allow\ngateway:\n  upstreams:\n    github:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(FAKE_GITHUB)}]\n    broken:\n      command: adtl-no-such-command\n`,
  );
  return config;
}

describe("runInit (real upstream process)", () => {
  it("scans upstreams, skips ones it can't reach, and only writes when asked", async () => {
    const config = tempConfig();
    const before = readFileSync(config, "utf8");
    const dry = await runInit({ path: config });
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(dry.reports).toEqual([expect.objectContaining({ id: "github", preset: "github", added: ["read_issue", "get_file", "list_repos", "post_comment"] })]);
    expect(dry.failed).toEqual([expect.objectContaining({ id: "broken" })]);

    await runInit({ path: config, write: true });
    expect(readFileSync(`${config}.bak`, "utf8")).toBe(before);
    expect(readFileSync(config, "utf8")).toBe(dry.text);
    expect(parseConfigText(dry.text).servers.github?.tools.read_issue?.egress).toBe("internal");
  });
});

describe.skipIf(!existsSync(CLI))("adtl-gateway init (CLI)", () => {
  it("prints the updated config to stdout and a summary to stderr", () => {
    const config = tempConfig();
    const r = spawnSync(process.execPath, [CLI, "init", "-c", config], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("post_comment: { egress: public } # preset github: write");
    expect(r.stderr).toContain("github (preset github): 4 tools added; defaults added");
    expect(r.stderr).toContain("broken: could not connect, skipped");
    expect(r.stderr).toContain("re-run with --write");
  });

  it("rejects --write outside init", () => {
    const r = spawnSync(process.execPath, [CLI, "--write", "-c", tempConfig()], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown argument: --write");
  });
});
