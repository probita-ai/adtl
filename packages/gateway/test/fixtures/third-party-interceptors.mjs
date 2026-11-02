// A third-party interceptor server for tests: one mutator that redacts "private"
// from tool results, and one validator that blocks post_comment.
// Usage: node third-party-interceptors.mjs [--late] [--name-clash]
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const late = process.argv.includes("--late");
const clash = process.argv.includes("--name-clash");

const interceptors = [
  {
    name: clash ? "adtl.label" : "redact.private",
    type: "mutation",
    hooks: [{ events: ["tools/call"], phase: "response" }],
    priorityHint: late ? 5000 : -50000,
  },
  { name: "deny.comments", type: "validation", hooks: [{ events: ["tools/call"], phase: "request" }] },
];

const server = new Server(
  { name: "third-party-interceptors", version: "0.0.0" },
  { capabilities: { extensions: { "io.modelcontextprotocol/interceptors": {} } } },
);
const on = (method, handler) =>
  server.setRequestHandler(z.object({ method: z.literal(method), params: z.any().optional() }).passthrough(), handler);

on("interceptors/list", () => ({ interceptors }));
on("interceptor/invoke", ({ params }) => {
  // Record what we were sent, so tests can check that no ADTL config leaks to us.
  if (params.config !== undefined) process.stderr.write(`third-party got config: ${JSON.stringify(params.config)}\n`);
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
