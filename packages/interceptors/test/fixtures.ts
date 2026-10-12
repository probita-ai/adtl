import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parseConfigText } from "../src/loadConfig.js";

export const EXAMPLE_CONFIG_PATH = fileURLToPath(new URL("../../../examples/adtl.yaml", import.meta.url));

export const exampleConfig = () => parseConfigText(readFileSync(EXAMPLE_CONFIG_PATH, "utf8"), EXAMPLE_CONFIG_PATH);

export const textResult = (text: string) => ({ content: [{ type: "text", text }] });

/** interceptor/invoke params for adtl.label on a tools/call response. */
export const labelCall = (tool: string, text: string, sessionId?: string) => ({
  name: "adtl.label",
  event: "tools/call",
  phase: "response" as const,
  payload: { method: "tools/call", params: { name: tool, arguments: {} }, result: textResult(text) },
  config: { server: "github" },
  ...(sessionId ? { context: { sessionId } } : {}),
});

/** interceptor/invoke params for adtl.policy on a tools/call request. */
export const policyCall = (tool: string, args: Record<string, unknown> = {}, sessionId?: string) => ({
  name: "adtl.policy",
  event: "tools/call",
  phase: "request" as const,
  payload: { method: "tools/call", params: { name: tool, arguments: args } },
  config: { server: "github" },
  ...(sessionId ? { context: { sessionId } } : {}),
});
