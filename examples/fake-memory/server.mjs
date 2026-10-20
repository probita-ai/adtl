#!/usr/bin/env node
// A fake memory MCP server for tests and demos, shaped like memory APIs that
// run a model on write. No network, no model.
//
// - add_memory stores the text. With infer (the default, as in common memory
//   APIs) it stores "extracted facts" instead: each sentence, reworded. A real
//   extractor rewords far more, which only makes the text harder to recognize.
//   With infer: false it stores the text as sent. Per-item metadata is kept.
//   Like Mem0, each add also keeps the raw text in a buffer of the last 10
//   messages per scope (the user_id, agent_id and run_id the call sets, matched
//   exactly), with no metadata. The "extractor" resolves "the same place as
//   before" in a new message from that buffer, so a fact can carry text from an
//   earlier call by another session.
// - search_memory returns every stored memory, one per line, with its metadata.
// - get_memory returns one memory by id.
// - update_memory changes a memory's text and lays the caller's metadata over
//   the stored metadata, like Mem0's update().
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

const PLACE = /(?:on|in) ([\w./-]+ issue \d+)/i;
const SAME_PLACE = /\b(?:in|on) the same place as before\b/i;

/** Stand-in for reference resolution: "the same place as before" becomes the last place named in the buffer. */
export function resolveReferences(text, lastMessages) {
  if (!SAME_PLACE.test(text)) return text;
  const place = lastMessages.map((m) => PLACE.exec(m)?.[1]).filter(Boolean).at(-1);
  return place ? text.replace(SAME_PLACE, `on ${place}`) : text;
}

/** Mem0's session scope: the ids the call sets, in a fixed order. */
const scopeOf = (ids) => ["agent_id", "run_id", "user_id"].filter((k) => ids[k]).map((k) => `${k}=${ids[k]}`).join("&");

/**
 * `memories` and `buffers` are shared storage, so several server instances
 * (one per session) see the same data.
 */
export function createFakeMemoryServer({ memories = [], buffers = new Map() } = {}) {
  const server = new McpServer({ name: "fake-memory", version: "0.0.1" });
  const text = (t) => ({ content: [{ type: "text", text: t }] });

  server.registerTool(
    "add_memory",
    {
      description: "Remember something for later sessions",
      inputSchema: {
        text: z.string(),
        infer: z.boolean().optional(),
        metadata: z.record(z.unknown()).optional(),
        user_id: z.string().optional(),
        agent_id: z.string().optional(),
        run_id: z.string().optional(),
      },
    },
    async ({ text: t, infer = true, metadata, ...ids }) => {
      const scope = scopeOf(ids);
      const buffer = buffers.get(scope) ?? [];
      const added = infer ? extractFacts(resolveReferences(t, buffer)) : [t];
      const stored = added.map((m) => ({ id: `m${memories.length + 1}`, text: m, ...(metadata ? { metadata: { ...metadata } } : {}) }));
      memories.push(...stored);
      buffers.set(scope, [...buffer, t].slice(-10));
      return {
        content: [{ type: "text", text: `Stored ${added.length} ${added.length === 1 ? "memory" : "memories"}` }],
        structuredContent: { ids: stored.map((m) => m.id) },
      };
    },
  );

  server.registerTool(
    "get_memory",
    { description: "Return one memory", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      const m = memories.find((x) => x.id === id);
      return m ? { content: [{ type: "text", text: m.text }], structuredContent: { memory: m } } : { ...text(`No memory ${id}`), isError: true };
    },
  );

  server.registerTool(
    "update_memory",
    {
      description: "Change a memory",
      inputSchema: { id: z.string(), text: z.string().optional(), metadata: z.record(z.unknown()).optional() },
    },
    async ({ id, text: t, metadata }) => {
      const m = memories.find((x) => x.id === id);
      if (!m) return { ...text(`No memory ${id}`), isError: true };
      if (t !== undefined) m.text = t;
      if (metadata) m.metadata = { ...(m.metadata ?? {}), ...metadata };
      return text("Updated");
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
