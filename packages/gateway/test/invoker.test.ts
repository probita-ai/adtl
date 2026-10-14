import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { InterceptorDefinition } from "@adtl/interceptors";
import { InterceptorInvoker } from "../src/index.js";

/** A fake interceptor server whose validators return fixed decisions. */
function validator(name: string, decision: "allow" | "ask" | "block"): { client: Client; definition: InterceptorDefinition } {
  const client = {
    request: async () => ({
      interceptor: name,
      type: "validation",
      phase: "request",
      valid: decision === "allow",
      severity: decision === "allow" ? "info" : "error",
      messages: decision === "allow" ? [] : [{ message: `${name} says ${decision}`, severity: "error" }],
      info: { "adtl/decision": decision },
    }),
  } as unknown as Client;
  return { client, definition: { name, type: "validation", hooks: [{ events: ["tools/call"], phase: "request" }] } };
}

const run = (inv: InterceptorInvoker) =>
  inv.runRequest({ event: "tools/call", payload: { params: { name: "t" } }, config: { server: "s" }, context: { sessionId: "x" } });

describe("InterceptorInvoker", () => {
  it("never lets an ask hide another validator's block, whatever the order", async () => {
    for (const order of [["ask", "block"], ["block", "ask"]] as const) {
      const out = await run(new InterceptorInvoker(order.map((d, i) => validator(`v${i}`, d))));
      expect(out.blocked).toMatchObject({ decision: "block" });
    }
    const asks = await run(new InterceptorInvoker([validator("a", "ask"), validator("b", "allow")]));
    expect(asks.blocked).toMatchObject({ decision: "ask", interceptor: "a" });
  });
});
