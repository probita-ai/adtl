// A third-party interceptor server for tests: one mutator that redacts "private"
// from tool results, and one validator that blocks post_comment.
// With --sink <file>, also a sink (proposed type) that appends each tools/call request
// it sees to <file>, answering after 1.5 s with --sink-slow; --sink-audit declares it
// with mode: "audit", which the gateway must refuse.
// Usage: node third-party-interceptors.mjs [--late] [--name-clash] [--sink <file> [--sink-slow] [--sink-audit]]
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const late = process.argv.includes("--late");
const clash = process.argv.includes("--name-clash");
const sinkFile = process.argv.includes("--sink") ? process.argv[process.argv.indexOf("--sink") + 1] : undefined;
const sinkSlow = process.argv.includes("--sink-slow");
const sinkAudit = process.argv.includes("--sink-audit");

const interceptors = [
  {
    name: clash ? "adtl.label" : "redact.private",
    type: "mutation",
    hooks: [{ events: ["tools/call"], phase: "response" }],
    priorityHint: late ? 5000 : -50000,
  },
  { name: "deny.comments", type: "validation", hooks: [{ events: ["tools/call"], phase: "request" }] },
  ...(sinkFile
    ? [{ name: "activity.feed", type: "sink", hooks: [{ events: ["tools/call"], phase: "request" }], ...(sinkAudit ? { mode: "audit" } : {}) }]
    : []),
];

const server = new Server(
  { name: "third-party-interceptors", version: "0.0.0" },
  { capabilities: { extensions: { "io.modelcontextprotocol/interceptors": {} } } },
);
const on = (method, handler) =>
  server.setRequestHandler(z.object({ method: z.literal(method), params: z.any().optional() }).passthrough(), handler);

on("interceptors/list", () => ({ interceptors }));
on("interceptor/invoke", async ({ params }) => {
  // Record what we were sent, so tests can check that no ADTL config leaks to us.
  if (params.config !== undefined) process.stderr.write(`third-party got config: ${JSON.stringify(params.config)}\n`);
  if (params.name === "activity.feed") {
    appendFileSync(sinkFile, `${JSON.stringify({ phase: params.phase, tool: params.payload?.params?.name })}\n`);
    if (sinkSlow) await new Promise((r) => setTimeout(r, 1500));
    return { interceptor: params.name, type: "sink", phase: params.phase, recorded: true };
  }
  if (params.name === "deny.comments") {
    const blocked = params.payload?.params?.name === "post_comment";
    return {
      interceptor: params.name,
      type: "validation",
      phase: params.phase,
      valid: !blocked,
      severity: blocked ? "error" : "info",
      messages: blocked ? [{ message: "third party says no comments", severity: "error" }] : [],
      configReceived: params.config !== undefined,
    };
  }
  const result = params.payload.result;
  const content = (result.content ?? []).map((c) => (c.type === "text" ? { ...c, text: c.text.replaceAll("private", "[redacted]") } : c));
  return { interceptor: params.name, type: "mutation", phase: params.phase, modified: true, payload: { ...params.payload, result: { ...result, content } } };
});

await server.connect(new StdioServerTransport());
