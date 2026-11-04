# Interceptor state across calls: use case and proposal

> **Draft for discussion** with the MCP Interceptors Working Group. Not part of SEP-2624. From [ADTL](../README.md), a personal open-source project that runs on SEP-2624 interceptors.

## The gap

SEP-2624 reserves "Context Propagation and Interceptor State" as future work. That sketch covers state that flows **across the interceptors of one operation**: an early interceptor enriches context for a later one. It ends when the operation ends.

ADTL needs state that lasts **across operations**. Reading a stranger's GitHub issue on one `tools/call` must change what `adtl.policy` decides on a later one. Nothing in the protocol carries that, so ADTL keeps it inside its interceptor server, keyed by `context.sessionId`.

That works, but it pulls against the SEP's own direction: per-invocation `config` exists "so that Interceptor Servers can remain stateless".

## What ADTL needs, from running it

| Need | Example | What ADTL does today |
| --- | --- | --- |
| State lasts for a session | Session label: the join of everything read | In-memory map by `sessionId` |
| Shared by several interceptors | `adtl.label` writes it, `adtl.policy` reads it | Both live in one server, so they share memory; two servers couldn't |
| Shared by several processes | Claude Code hooks and the gateway add to one label | Append-only files in `~/.adtl/sessions` |
| Shared across agents | A sub-agent starts from its parent's label, and taints it | Same files, joined by `ADTL_SESSION_ID` |
| Survives a restart | A label must not reset when the server restarts | Files only; the in-memory store loses it |
| Can't be weakened by the invoker or agent | A compromised client must not clear a label | Kept out of the client's hands entirely |

The last row is why handing state to the invoker is not obviously right, and why this needs discussion rather than a field.

## Proposal

Add an optional, opaque, per-interceptor state that the invoker stores and returns, and that the interceptor protects if it needs to.

```typescript
// Result of any interceptor
interface InterceptorResult {
  // ...
  /** Replaces this interceptor's state for the scope. Absent means unchanged. */
  stateUpdate?: { scope: "session"; state: string; version: number };
}

// interceptor/invoke context
interface InvocationContext {
  // ...
  /** What this interceptor last returned for this session. */
  state?: { scope: "session"; state: string; version: number };
}
```

- **Opaque.** `state` is a string to the invoker. An interceptor that must not trust the invoker signs or encrypts it, so tampering is detected.
- **Scoped by interceptor name.** An invoker passes an interceptor only its own state. Sharing between interceptors stays explicit: a group name in the descriptor could allow it.
- **Versioned.** An update names the version it was based on, so an invoker can reject a lost update. Validators run in parallel, so they would read state and not write it, or updates would need a merge rule.
- **Optional.** Interceptors that keep their own state, as ADTL does today, are unaffected.

## What this doesn't solve

- **Rollback.** A signature shows state is genuine, not that it's the latest: an invoker can replay an older, cleaner label. For a label that only gets stricter, that is the attack that matters. A monotonic `version` checked by the interceptor needs the interceptor to remember the highest version, which is state again. So security state may have to stay in the interceptor server, and this proposal would mainly serve state that isn't adversarial, such as rate limits or trace data.
- **Several processes and agents.** Invoker-held state doesn't reach a Claude Code hook or a sub-agent's own gateway. Those need a shared store, or a session id they all agree on.

## Questions for the WG

1. Is cross-call state in scope for interceptors at all, or should the SEP say plainly that session state belongs in the Interceptor Server, keyed by `context.sessionId`?
2. If it stays in the server, should the SEP soften "stateless", and define what `sessionId` guarantees (stable for a session, shared by all interceptors, safe to key security state on)?
3. Should invokers be able to link sessions, for example a `parentSessionId` in context for sub-agents?
