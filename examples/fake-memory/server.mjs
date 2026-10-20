#!/usr/bin/env node
// A fake memory MCP server for tests and demos, shaped like memory APIs that
// run a model on write. No network, no model.
//
// - add_memory stores the text. With infer (the default, as in common memory
//   APIs) it stores "extracted facts" instead: each sentence, reworded. A real
//   extractor rewords far more, which only makes the text harder to recognize.
//   With infer: false it stores the text as sent. Per-item metadata is kept.
// - search_memory returns every stored memory, one per line, with its metadata.
// - consolidate merges all memories into one record, as servers that
//   deduplicate or summarize do. The merged record keeps no metadata.
//
// Run over stdio:  node examples/fake-memory/server.mjs

import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Stand-in for a model that extracts facts: one reworded fact per sentence. */
export function extractFacts(text) {
  return text
    .replace(/<!--|-->/g, " ")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim().replace(/[.!?]+$/, ""))
    .filter((s) => s.length > 0)
    .map((s) => `User noted that ${s.charAt(0).toLowerCase()}${s.slice(1)}`);
}

/** `memories` is shared storage, so several server instances (one per session) see the same data. */
export function createFakeMemoryServer({ memories = [] } = {}) {
  const server = new McpServer({ name: "fake-memory", version: "0.0.1" });
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  server.registerTool(
    "add_memory",
    {
      description: "Remember something for later sessions",
      inputSchema: { text: z.string(), infer: z.boolean().optional(), metadata: z.record(z.unknown()).optional() },
    },
    async ({ text: t, infer = true, metadata }) => {
      const added = infer ? extractFacts(t) : [t];
      for (const m of added) memories.push({ text: m, ...(metadata ? { metadata } : {}) });
      return text(`Stored ${added.length} ${added.length === 1 ? "memory" : "memories"}`);
    },
  );

  server.registerTool(
    "search_memory",
    { description: "Return what was remembered", inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
    async () => ({
      content: [{ type: "text", text: memories.map((m) => m.text).join("\n") }],
      structuredContent: { memories },
    }),
  );

  server.registerTool("consolidate", { description: "Merge all memories into one" }, async () => {
    const merged = memories.map((m) => m.text).join("; ");
    memories.splice(0, memories.length, { text: merged });
    return text("Consolidated");
  });

  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await createFakeMemoryServer().connect(new StdioServerTransport());
}
