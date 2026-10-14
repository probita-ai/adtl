# Changelog

## 0.1.1 — experimental

### `@adtl/gateway`
- Audit mode: `gateway.mode: audit` or `adtl-gateway --audit` logs what the policy would stop, without stopping or changing anything. Use it to try a policy out safely. Audit log entries get `"mode": "audit"`, and calls the policy would have stopped keep their `decision`, `reason` and `matched` rules.
- `InterceptorInvoker` takes an optional mode override for every interceptor, as SEP-2624 allows invokers to do.
- Audit log entries no longer report `decision: "allow"` when the policy result is missing.

## 0.1.0 — experimental

First public release. Built on draft MCP proposals that are still changing, so expect breaking changes.

### `@adtl/labels`
- Label model: integrity, confidentiality and origins. Combining labels only makes them stricter.
- Codec for MCP's draft `trust-annotations` extension (`_meta["io.modelcontextprotocol/trust-annotations"]`).
- Config-driven labeling rules. Server claims can only make labels stricter unless the server is allowlisted.
- Policy evaluation (`allow` / `ask` / `block`; the most restrictive match wins).
- Canonical call hashing, so decisions are bound to one exact call.

### `@adtl/interceptors`
- SEP-2624 interceptor server (`interceptors/list`, `interceptor/invoke`) with `adtl.label` (mutation) and `adtl.policy` (validation).
- Per-session label state. Policy checks fail closed without a session id.
- `adtl-interceptors --config adtl.yaml` CLI over stdio.

### `@adtl/gateway`
- MCP gateway for stdio and Streamable HTTP upstream servers. Tools are exposed as `<server>__<tool>`.
- Runs interceptors in SEP-2624 order and fails closed on interceptor errors.
- `${VAR}` expansion for secrets in config.
- JSONL audit log with no arguments or results.
- `adtl-gateway --config adtl.yaml` CLI.

### Known limits
- `ask` is treated as `block`; approvals are planned for v0.2.
- Only tools are proxied (no resources or prompts yet).
- Labels last for one session; persistence across files and memory is planned for v0.3.
