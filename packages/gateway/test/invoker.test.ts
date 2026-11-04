import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { InterceptorDefinition } from "@adtl/interceptors";
import { InterceptorInvoker, checkOverrides, unsupportedInterceptors } from "../src/index.js";

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

  it("applies per-interceptor overrides of mode, failOpen, timeout and priority", async () => {
    const block = validator("strict", "block");
    // mode: audit makes a blocking validator log only.
    const audited = await run(new InterceptorInvoker([block], 5000, undefined, { strict: { mode: "audit" } }));
    expect(audited.blocked).toBeUndefined();
    expect(audited.ran[0]).toMatchObject({ mode: "audit", modeFrom: "override", failOpen: false, failOpenFrom: "default" });

    // failOpen and timeoutMs: a hanging validator times out at the override and is let through.
    const hang = { client: { request: () => new Promise(() => {}) } as unknown as Client, definition: block.definition };
    const t0 = Date.now();
    const open = await run(new InterceptorInvoker([hang], 5000, undefined, { strict: { failOpen: true, timeoutMs: 50 } }));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(open.blocked).toBeUndefined();
    expect(open.ran[0]).toMatchObject({ failOpen: true, failOpenFrom: "override", timeoutMs: 50, failed: true });

    // priorityHint: an override reorders mutators.
    const order: string[] = [];
    const mutator = (name: string, priorityHint: number) => ({
      client: { request: async () => (order.push(name), { interceptor: name, type: "mutation", phase: "request", modified: false }) } as unknown as Client,
      definition: { name, type: "mutation", priorityHint, hooks: [{ events: ["tools/call"], phase: "request" }] } as InterceptorDefinition,
    });
    await run(new InterceptorInvoker([mutator("a", 1), mutator("b", 2)], 5000, undefined, { b: { priorityHint: { request: 0 } } }));
    expect(order).toEqual(["b", "a"]);
  });

  it("keeps a global audit mode over a per-interceptor one", async () => {
    const out = await run(new InterceptorInvoker([validator("strict", "block")], 5000, "audit", { strict: { mode: "active" } }));
    expect(out.blocked).toBeUndefined();
    expect(out.ran[0]).toMatchObject({ mode: "audit" });
  });

  it("narrows hooks, and rejects overrides that widen them or name unknown interceptors", async () => {
    const block = validator("strict", "block");
    const narrowed = new InterceptorInvoker([block], 5000, undefined, { strict: { hooks: [{ events: ["tools/call"], phase: "response" }] } });
    expect((await run(narrowed)).ran).toEqual([]);

    const defs = [block.definition, { ...validator("any", "allow").definition, hooks: [{ events: ["*"], phase: "request" as const }] }];
    expect(checkOverrides(defs, { strict: { hooks: [{ events: ["tools/call"], phase: "request" }] } })).toEqual([]);
    expect(checkOverrides(defs, { any: { hooks: [{ events: ["resources/read"], phase: "request" }] } })).toEqual([]);
    expect(checkOverrides(defs, { strict: { hooks: [{ events: ["resources/read"], phase: "request" }] } })[0]).toMatch(/only narrow/);
    expect(checkOverrides(defs, { strict: { hooks: [{ events: ["*"], phase: "request" }] } })[0]).toMatch(/only narrow/);
    expect(checkOverrides(defs, { strict: { hooks: [{ events: ["tools/call"], phase: "response" }] } })[0]).toMatch(/only narrow/);
    expect(checkOverrides(defs, { typo: { mode: "audit" } })[0]).toMatch(/no such interceptor/);
  });
});

describe("InterceptorInvoker with several servers", () => {
  it("sends the gateway's config only to interceptors that want it", async () => {
    const seen: Record<string, unknown>[] = [];
    const client = {
      request: async (req: { params: Record<string, unknown> }) => (seen.push(req.params), { valid: true, severity: "info" }),
    } as unknown as Client;
    const def = (name: string): InterceptorDefinition => ({ name, type: "validation", hooks: [{ events: ["tools/call"], phase: "request" }] });
    await run(new InterceptorInvoker([{ client, definition: def("ours") }, { client, definition: def("theirs"), sendConfig: false }]));
    expect(seen.find((p) => p.name === "ours")).toHaveProperty("config", { server: "s" });
    expect(seen.find((p) => p.name === "theirs")).not.toHaveProperty("config");
  });
});

describe("unsupportedInterceptors", () => {
  it("names interceptors of a type the invoker never runs", () => {
    const sink = { client: {} as Client, definition: { name: "avatar-mood", type: "sink", hooks: [] } as unknown as InterceptorDefinition };
    expect(unsupportedInterceptors([validator("v", "allow"), sink])).toEqual(["avatar-mood (sink)"]);
  });
});
