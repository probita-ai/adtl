# Changelog

## Unreleased

### `@adtl/interceptors`
- `adtl.policy` returns "ask" with a `confirmation` request (`id`, `reason`, `callHash`, `expiresAt`, `token`), as proposed in experimental-ext-interceptors#45, and accepts `context.confirmations` when invoked again. Each confirmation allows one call, in one session, before it expires. `info["adtl/decision"]` is still set.
- `callHash` now covers the SEP-2624 call binding `{ event, phase, target, payload }`, so audit log hashes differ from 0.4.0.

### `@adtl/labels`
- `callBindingHash()`.

### `@adtl/gateway`
- The README shows the architecture sketch on npm too.
- Sets `context.target` to the upstream server on every interceptor invocation.
- After a human approves a call, checks it again with the confirmation and runs it only if every validator allows it and the call still matches the approved hash.
- `ChainOutcome` is now `PhaseOutcome`, since SEP-2624 no longer talks about chains.

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
