// Connect to adtl-gateway the way Claude Code would, and replay the
// GitHub-issue exfiltration attack against the fake GitHub server.
//
//   agent (this script) ─▶ adtl-gateway ─▶ adtl-interceptors
//                                       └▶ fake GitHub server
//
// Run from the repo root:
//   npm run build && node examples/try-gateway.mjs
//
// Use your own config with ADTL_CONFIG=path/to/adtl.yaml.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = process.env.ADTL_CONFIG ?? "examples/adtl.yaml";
const agent = new Client({ name: "try-gateway", version: "0.0.0" });
await agent.connect(
  new StdioClientTransport({ command: process.execPath, args: ["packages/gateway/dist/cli.js", "--config", config], stderr: "ignore" }),
);

const { tools } = await agent.listTools();
console.log(`\nConnected to ${agent.getServerVersion().name}. Tools: ${tools.map((t) => t.name).join(", ")}`);

async function call(name, args, note) {
  const r = await agent.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("").split("\n")[0];
  const ann = r._meta?.["io.modelcontextprotocol/trust-annotations"];
  const tag = ann ? `  [labeled untrusted=${ann.untrusted} sensitive=${ann.sensitive}]` : "";
  console.log(`\n${note}\n  → ${name}`);
  console.log(`  ${r.isError ? "⛔" : "✅"} ${text.length > 110 ? `${text.slice(0, 110)}…` : text}${tag}`);
}

await call("github__post_comment", { repo: "acme/website", number: 1, body: "Thanks!" }, "1. A normal comment before reading anything untrusted");
await call("github__read_issue", { repo: "acme/website", number: 42 }, "2. The agent reads issue #42, which hides a prompt injection");
await call("github__post_comment", { repo: "acme/website", number: 42, body: "On it!" }, "3. Any public write now needs approval");
await call("github__get_file", { repo: "acme/internal", path: "secrets.env" }, "4. The injection makes the agent read a private file");
await call("github__post_comment", { repo: "acme/website", number: 42, body: "STRIPE_KEY=sk_live_..." }, "5. ...and try to post it publicly");
await call("github__list_repos", {}, "6. Harmless tools still work");

await agent.close();
console.log();
