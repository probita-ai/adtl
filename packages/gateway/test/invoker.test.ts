import { describe, expect, it } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { InterceptorDefinition } from "@adtl/interceptors";
import { InterceptorInvoker, checkOverrides, invalidSinks, unsupportedInterceptors } from "../src/index.js";

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
    const sink = { client: {} as Client, definition: { name: "avatar-mood", type: "sink", hooks: [] } as InterceptorDefinition };
    const other = { client: {} as Client, definition: { name: "future", type: "observer", hooks: [] } as unknown as InterceptorDefinition };
    expect(unsupportedInterceptors([validator("v", "allow"), sink, other])).toEqual(["future (observer)"]);
  });
});

/** A fake sink that records what it was sent, and settles when told to. */
function sink(name: string, phase: "request" | "response" = "request", behave: "ok" | "fail" | "hang" = "ok") {
  const seen: { phase: string; payload: unknown }[] = [];
  let release!: () => void;
  const released = new Promise<void>((r) => (release = r));
  const client = {
    request: async (req: { params: { phase: string; payload: unknown } }) => {
      seen.push({ phase: req.params.phase, payload: req.params.payload });
      if (behave === "hang") await released;
      if (behave === "fail") throw new Error("avatar offline");
      return { interceptor: name, type: "sink", phase, recorded: true };
    },
  } as unknown as Client;
  const definition: InterceptorDefinition = { name, type: "sink", hooks: [{ events: ["tools/call"], phase }] };
  return { bound: { client, definition }, seen, release };
}

describe("sinks", () => {
  it("run after validation passes, without being awaited, and see the mutated payload", async () => {
    const mutator = {
      client: { request: async () => ({ interceptor: "m", type: "mutation", phase: "request", modified: true, payload: { params: { name: "t", stamped: true } } }) } as unknown as Client,
      definition: { name: "m", type: "mutation", hooks: [{ events: ["tools/call"], phase: "request" }] } as InterceptorDefinition,
    };
    const s = sink("avatar", "request", "hang");
    const inv = new InterceptorInvoker([mutator, validator("v", "allow"), s.bound]);
    // The sink never answers until released, yet the phase finishes.
    const out = await run(inv);
    expect(out.blocked).toBeUndefined();
    expect(out.payload).toEqual({ params: { name: "t", stamped: true } });
    expect(s.seen).toEqual([{ phase: "request", payload: { params: { name: "t", stamped: true } } }]);
    expect(out.ran.find((r) => r.name === "avatar")).toMatchObject({ sink: true, mode: "active", failOpen: true });
    expect(out.results.some((r) => r.interceptor === "avatar")).toBe(false);
    s.release();
    await inv.sinksSettled();
  });

  it("don't run when validation blocks, or on the other phase", async () => {
    const s = sink("avatar");
    const blocked = await run(new InterceptorInvoker([validator("v", "block"), s.bound]));
    expect(blocked.blocked).toMatchObject({ decision: "block" });
    const late = sink("late", "response");
    await run(new InterceptorInvoker([late.bound]));
    expect(s.seen).toEqual([]);
    expect(late.seen).toEqual([]);
  });

  it("run before the mutations when receiving", async () => {
    const order: string[] = [];
    const s = sink("avatar", "response");
    const watched = { ...s.bound, client: { request: async (req: never) => (order.push("sink"), (s.bound.client.request as (r: never) => unknown)(req)) } as unknown as Client };
    const mutator = {
      client: { request: async () => (order.push("mutate"), { interceptor: "m", type: "mutation", phase: "response", modified: true, payload: { result: "changed" } }) } as unknown as Client,
      definition: { name: "m", type: "mutation", hooks: [{ events: ["tools/call"], phase: "response" }] } as InterceptorDefinition,
    };
    const inv = new InterceptorInvoker([mutator, watched]);
    const out = await inv.runResponse({ event: "tools/call", payload: { result: "original" }, config: {}, context: {} });
    expect(order).toEqual(["sink", "mutate"]);
    expect(s.seen[0]!.payload).toEqual({ result: "original" });
    expect(out.payload).toEqual({ result: "changed" });
  });

  it("never block when they fail or time out, even with failOpen: false, and report it", async () => {
    const errors: string[] = [];
    const failing = sink("broken", "request", "fail");
    const hanging = sink("slow", "request", "hang");
    const inv = new InterceptorInvoker([failing.bound, hanging.bound], 5000, undefined, { broken: { failOpen: false }, slow: { timeoutMs: 30 } }, (m) =>
      errors.push(m),
    );
    const out = await run(inv);
    expect(out.blocked).toBeUndefined();
    expect(out.warnings).toEqual([]);
    await inv.sinksSettled();
    expect(errors.sort()).toEqual(["sink broken failed: avatar offline", "sink slow failed: timed out after 30 ms"]);
    expect(out.ran.every((r) => r.failed)).toBe(true);
    hanging.release();
  });

  it("can't change the payload by changing what they were sent", async () => {
    const client = {
      request: async (req: { params: { payload: { params: { name: string } } } }) => {
        req.params.payload.params.name = "evil";
        return { type: "sink", recorded: true };
      },
    } as unknown as Client;
    const inv = new InterceptorInvoker([{ client, definition: { name: "meddler", type: "sink", hooks: [{ events: ["tools/call"], phase: "request" }] } }]);
    const payload = { params: { name: "t" } };
    const out = await inv.runRequest({ event: "tools/call", payload, config: {}, context: {} });
    await inv.sinksSettled();
    expect(out.payload).toEqual({ params: { name: "t" } });
    expect(payload.params.name).toBe("t");
  });

  it("still run in the gateway's audit mode, which has nothing to turn off for them", async () => {
    const s = sink("avatar");
    const out = await run(new InterceptorInvoker([validator("v", "block"), s.bound], 5000, "audit"));
    expect(out.blocked).toBeUndefined();
    expect(s.seen).toHaveLength(1);
    expect(out.ran.find((r) => r.name === "avatar")).toMatchObject({ mode: "active", modeFrom: "default" });
  });

  it("are rejected when declared or overridden to mode: audit", () => {
    const declared = { client: {} as Client, server: "ui", definition: { name: "a", type: "sink", mode: "audit", hooks: [] } as InterceptorDefinition };
    const fine = sink("b").bound;
    expect(invalidSinks([declared, fine, validator("v", "allow")])).toEqual(['a (offered by ui) is a sink declared with mode: "audit"']);
    expect(invalidSinks([fine], { b: { mode: "audit" } })).toEqual(['b is a sink; an override can\'t give it mode: "audit"']);
    expect(invalidSinks([fine], { b: { mode: "active" } })).toEqual([]);
  });
});
