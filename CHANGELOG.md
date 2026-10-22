# Changelog

## Unreleased

### `@adtl/labels`
- Ed25519 signing keys: `loadOrCreateSigner()` (`~/.adtl/signing-key.pem`, or `ADTL_SIGNING_KEY`; created on first use, mode 0600), `loadSigner()`, `signCanonical()`, `verifyCanonical()`, `verifySignature()`. Public keys are written `ed25519:<base64url>`.
- Policy rules with `then: ask` take `approvers: [role, …]`: who may answer ([#10](https://github.com/probita-ai/adtl/issues/10)). The decision carries each winning rule's approver roles.
- `globToRegExp()` is exported, for `server.name` patterns.

### `@adtl/ledger`
- Signed entries ([#29](https://github.com/probita-ai/adtl/issues/29)): with a `signer`, every entry, declassifications included, carries an Ed25519 signature over its hash and the signer's public key. `verify()` reports bad signatures, entries signed by keys outside `trustedKeys` (default: the signer's own), and unsigned entries after signed ones. Older ledgers get the new columns automatically; their entries count as written before signing.

### `@adtl/gateway`
- Session receipts ([#26](https://github.com/probita-ai/adtl/issues/26)): `adtl-gateway receipt <session>` writes a signed summary of every call a session made (tool, outcome, decision, approver, call hash, result label, audit line hash, counts), built from the verified audit log. `receipt verify` checks the signature, the signer (`--key`) and, with `--log`, that no call was left out. `receipt list` shows sessions; `adtl-gateway key` prints the public key.
- The interceptors, the Claude Code hook and `ledger declassify` sign ledger entries with the machine's key; `ledger verify` reports signatures. The hook guards the key file like the ledger.
- Approvals in the MCP client ([#6](https://github.com/probita-ai/adtl/issues/6)): with `gateway.approvals.elicitation: true`, an "ask" is also shown in clients that support elicitation, with Allow and Deny; the first answer from any channel wins. Declining or dismissing denies. Off by default, and never used for rules with named approvers.
- Named approvers ([#10](https://github.com/probita-ai/adtl/issues/10)): `gateway.approvals.approvers` gives each person their own ntfy topic. An "ask" whose rules name approver roles goes only to those people, with tokens signed for each of them, and an answer counts only on the same person's reply topic, so the audit log records `approver`. Startup checks that every named role exists, has named members, and that each member has a channel.
- Role-based authorization in the config ([#8](https://github.com/probita-ai/adtl/issues/8)): `gateway.roles` grants tools and prompts (`server.name` patterns, as in policy rules) and resources (URI patterns) to principal ids, or to `"*"`. Once present, anything no role grants is denied. Config errors name the role and field.
- Audit entries list every interceptor that ran, with its resolved `mode` and `failOpen` and whether each came from an override or the interceptor's default, as SEP-2624 recommends ([#36](https://github.com/probita-ai/adtl/issues/36)): `interceptors: [{ name, phase, mode, modeFrom, failOpen, failOpenFrom, failed? }]`.
- `tools/list`, `prompts/list` and `resources/list` leave out what the authorizer would deny, so the agent doesn't try it ([#13](https://github.com/probita-ai/adtl/issues/13)). Calls are still checked; nothing is hidden in audit mode.
- `gateway.principal` sets who runs the gateway (`${VAR}` works in its `id`); it is passed to the authorizer and to the interceptors as `context.principal`.

### `@adtl/interceptors`
- `config.server` is optional: without it, `adtl.label` and `adtl.policy` use `context.target`, following SEP-2624's rule that an interceptor invoked without config uses its defaults.

## 0.5.1 — experimental

Record labels now hold up on memory servers that resolve references from recent messages and overlay updates, such as Mem0 ([#41](https://github.com/probita-ai/adtl/issues/41)). Thanks to Edward Izgorodin for the analysis of Mem0's message buffer.

### `@adtl/labels`
- Record stamps are written under a key per session, `adtl/record-label/<session>`, and stamp keys the agent supplies are dropped. On servers that lay an update's metadata over the stored metadata (Mem0), a clean session's update no longer replaces a tainted stamp. Stamps written by 0.5.0 under the single `adtl/record-label` key are still read.
- Tool rule `scopeInto` (e.g. `run_id`): a tainted session's writes get a scope id named after its label, so servers that resolve references from recent messages of the same scope (Mem0) don't build a clean session's facts from a tainted session's text. Clean sessions can't name a tainted scope. `scopeRecord()`.

### `@adtl/interceptors`
- `adtl.label` applies `scopeInto` on the request phase of `tools/call`, alongside `labelInto`.

### `@adtl/gateway`
- Docs: which Mem0 paths carry record labels and which need a strict rule (`history()`, and `list_events` / `get_event_status` on Mem0's hosted MCP server).

### Examples
- `examples/fake-memory` keeps Mem0's 10-message buffer per scope, resolves "the same place as before" from it, and has `get_memory` and `update_memory` (metadata overlaid).

## 0.5.0 — experimental

Labels now survive memory servers that rewrite what they store, the audit log is tamper-evident, "ask" follows the confirmation proposal for SEP-2624, and the gateway can check who may use a tool before the policy runs.

### Breaking changes
- `callHash` now covers the SEP-2624 call binding `{ event, phase, target, payload }`, so hashes in audit logs differ from 0.4.
- `adtl-gateway ledger declassify` requires `--reason`.
- `ChainOutcome` is now `PhaseOutcome` (`@adtl/gateway`), since SEP-2624 no longer has a chain concept.
- `adtl.label` also hooks the request phase of `tools/call`. This only matters if you run ADTL's interceptors behind your own invoker.

### `@adtl/labels`
- Tool rules take `labelInto` (stamp the session label into a per-record argument such as `metadata`) and `readLabels` (join stamps found in results, stricter only), for memory servers that extract facts or merge records, which the ledger can't recognize. `stampRecordLabel()` and `readRecordLabels()`.
- `callBindingHash()`.

### `@adtl/interceptors`
- `adtl.policy` returns "ask" with a `confirmation` request (`id`, `reason`, `callHash`, `expiresAt`, `token`), as proposed in [experimental-ext-interceptors#45](https://github.com/modelcontextprotocol/experimental-ext-interceptors/pull/45), and accepts `context.confirmations` when invoked again. Each confirmation allows one call, in one session, before it expires. A confirmation never turns a block into an allow. `info["adtl/decision"]` is still set.
- `adtl.label` stamps records for tools with `labelInto`, and joins the stamps it finds for tools with `readLabels`.

### `@adtl/ledger`
- `declassify()` takes a subject (e.g. the file name), kept with the reason. `declassifications()` lists recent declassifications.

### `@adtl/gateway`
- `Authorizer` interface: decides whether the caller may use a tool, resource or prompt at all, before the policy runs. A denial wins over any policy decision; failures deny; audit mode only logs. Pass it as `new AdtlGateway({ authorizer, principal })`; denials are audited as `denied: { by, reason }`. No config support yet ([#8](https://github.com/probita-ai/adtl/issues/8)).
- After a human approves a call, the gateway checks it again with the confirmation and runs it only if every validator allows it and the call still matches the approved hash. The confirmation token never reaches the agent.
- Sets `context.target` to the upstream server, and `context.principal` to the configured principal, on every interceptor invocation.
- The audit log is hash-chained: each line carries `prev` and `hash`. `adtl-gateway audit verify` detects edited, removed, reordered and inserted lines and prints the last hash. The gateway and the Claude Code hook append through a lock file so the chain doesn't fork. Logs from 0.4 are continued, with their lines reported as written before the chain.
- The Claude Code hook guards the audit log like the ledger: `Write`/`Edit` on it are blocked, shell commands that mention it ask first.
- `ledger declassify` records the file with the reason. New `ledger declassified` lists recent declassifications: when, who, which file, why.
- Audit entries get `records: { stamps, writers }` when a result carried record stamps.
- The npm README shows the architecture sketch.

### Examples and docs
- `examples/fake-memory`: a memory server that extracts facts on write, keeps per-item metadata and consolidates records, used in the tests.
- The README has a diagram of a label following content through a memory server.

## 0.4.0 — experimental

Requires Node.js 22.13 or later (for the built-in `node:sqlite`).

### `@adtl/ledger` (new)
- The label ledger: when a session that has read untrusted or private data sends text anywhere, the text's chunk hashes are recorded with the session's label; results containing that text are re-labeled when read back, in any session. Clean sessions record nothing.
- Chunks: the whole text, paragraphs and lines of 32+ characters, normalized (NFC, lowercase, whitespace collapsed).
- One SQLite file (`~/.adtl/ledger.db`, or `ADTL_LEDGER`), safe to share between processes. Entries are hash-chained (`verify` detects edits and deletions) and pruned after 90 days. Damaged labels count as untrusted and private.
- Declassify: a person can clear the label of specific content.

### `@adtl/labels`
- `ledger:` config section: `enabled` (default true), `path`, `retentionDays` (default 90).

### `@adtl/interceptors`
- `adtl.label` looks results up in the ledger and joins any match into the label (`info.ledger`), and records the call's arguments when the session is tainted.

### `@adtl/gateway`
- The Claude Code hook uses the ledger too: tool output is looked up; tool input (`Write`/`Edit` content, `Task` prompts, ...) and lines a shell command added to files (`bashEditDiff`) are recorded.
- `adtl-gateway ledger stats | verify | declassify <file>...`.
- The hook blocks `Write`/`Edit` on the ledger file and asks before shell commands that mention it or `ledger declassify`.
- Audit log entries have `ledger: { chunks, writers }` when the ledger matched.
- The interceptor process gets `ADTL_LEDGER` from the gateway's environment.
- Demo: `npm run demo:ledger`, a delayed injection written on Monday and triggered on Tuesday.

## 0.3.2 — experimental

### `@adtl/gateway`
- `adtl-gateway init --from .mcp.json`: imports the stdio and HTTP servers of an MCP client config (Claude Code's `.mcp.json`, or any file with `mcpServers`) into `gateway.upstreams`, creating `adtl.yaml` if it doesn't exist, then drafts rules as before. With `--write`, the client config is changed to run the gateway in place of the imported servers (original kept as `.bak`). SSE servers, entries that already run the gateway, and upstreams already in `adtl.yaml` are left alone.
- `${VAR:-default}` in the gateway config uses `default` when `VAR` is unset or empty, as in Claude Code's `.mcp.json`.
- `init` no longer folds long values such as paths across lines.

## 0.3.1 — experimental

### `@adtl/gateway`
- `adtl-gateway hook --config adtl.yaml`: a Claude Code hook for `PreToolUse`, `PostToolUse` and `PostToolUseFailure`. Built-in tools (`WebFetch`, `WebSearch`, `Bash`, `Read`, ...) and MCP servers that don't go through the gateway are labeled and checked against the same policy. `block` denies the call, `ask` shows Claude Code's permission prompt, and `allow` gives no answer, so Claude Code's own permissions still apply. Hook errors exit with code 2, which stops the call.
- Built-in tools are labeled as the server `claude-code`, from a preset that `servers.claude-code.tools` can override.
- The hook refuses `Write`/`Edit` on the ADTL config and session files, and asks before shell commands that mention the session directory.
- Under Claude Code (`CLAUDE_CODE_SESSION_ID` set), the gateway uses Claude Code's session id and keeps session labels in `~/.adtl/sessions/` (or `ADTL_SESSIONS_DIR`), shared with the hook. Labels now last across `claude --resume`.
- Audit log entries written by the hook have `"via": "claude-code-hook"`; calls handed to Claude Code's prompt have `outcome` `asked`.

### `@adtl/interceptors`
- `adtl-interceptors --sessions-dir <dir>` (or `ADTL_SESSIONS_DIR`) keeps session labels in files instead of memory.

### `@adtl/labels`
- `FileSessionStore`: session labels in append-only JSONL files, safe to share between processes. A damaged line counts as untrusted and private.

## 0.3.0 — experimental

### `@adtl/gateway`
- Proxies resources (`resources/list`, `resources/templates/list`, `resources/read`) and prompts (`prompts/list`, `prompts/get`), so content from them is labeled and counts toward the session label. Prompts are renamed `<server>__<prompt>`, like tools. Resource URIs are passed through unchanged and routed to the upstream that lists them, or whose template matches. A URI more than one upstream could serve is refused, because ADTL couldn't tell which server to label it as.
- Resources and prompts are offered only when at least one upstream offers them.
- Audit log entries have `event` `resources/read` or `prompts/get` with `resource` or `prompt` in place of `tool`.

- `adtl-gateway init -c adtl.yaml [--write]` drafts a labeling rule for every tool of every upstream that the config doesn't cover yet, plus server defaults for resources and prompts. Presets for the GitHub, filesystem and fetch servers; other servers get rules from MCP tool hints (egress only; results stay untrusted and private). Existing entries are never changed; `--write` keeps the original as `.bak`.

### `@adtl/interceptors`
- `adtl.label` also hooks `prompts/get`.

### `@adtl/labels`
- Label origins can name a `prompt`.
- Server trust claims are read from resource `contents` and prompt `messages`, not only tool `content`.

## 0.2.0 — experimental

### `@adtl/gateway`
- Approvals: with `gateway.approvals` configured, an `ask` decision holds the call and asks a human instead of blocking. Deny, no answer before `timeoutSeconds` (default 50), or failing to reach anyone stops the call.
- ntfy push notifications with Allow / Deny buttons. Answers come back through a reply topic, so the gateway needs no open port.
- Signed approval tokens: HMAC over the approval id, the call's hash, the decision and the expiry. Single use; forged, reused or late answers are ignored.
- Email notices over SMTP (notify only, no approve links) for pending, blocked and resolved approvals.
- ntfy publishes retry up to 3 times on network errors, 429 and 5xx, so one dropped connection doesn't deny a call. Warnings include the cause, e.g. `fetch failed (ECONNRESET)`.
- Pluggable `Notifier` interface for more channels.
- Progress notifications while a call waits for approval.
- Audit log entries record `approval: { outcome, channel, waitedMs }`.
- When one validator asks and another blocks, the block always wins, so an approval can never override it.

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
