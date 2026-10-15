# @adtl/gateway

> **Experimental.** ADTL is a personal open-source project built on draft MCP proposals ([trust-annotations](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations), [SEP-2624 interceptors](https://github.com/modelcontextprotocol/experimental-ext-interceptors)) that are still changing. It is not a security guarantee: don't rely on it to protect production systems yet. Feedback is very welcome.

An MCP gateway for AI agents. It sits between your agent (Claude Code, Cursor, any MCP client) and your MCP servers, and:

- **labels every tool result**: where it came from, whether it can be trusted, how sensitive it is (MCP's draft `trust-annotations` format)
- **checks every tool call** against what the session has already seen: allow, ask, or block
- **asks you on your phone** before risky calls, with Allow / Deny buttons (via [ntfy](https://ntfy.sh)), and can email you notices
- **writes an audit log** of every decision (no arguments or results are stored)

It stops attacks like the 2025 GitHub MCP exfiltration, where a public issue told an agent to post private repository contents in a comment.

## Quick start

1. Describe your tools in `adtl.yaml`:

   ```yaml
   servers:
     github:
       tools:
         get_issue:   { integrity: untrusted, confidentiality: public,  egress: none }
         get_file:    { integrity: trusted,   confidentiality: private, egress: none }
         add_comment: { integrity: trusted,   confidentiality: public,  egress: public }

   policy:
     rules:
       - name: private-stays-private
         when: { session.confidentiality: [private, secret], tool.egress: public }
         then: block
         reason: Private data must not reach a public tool

   gateway:
     upstreams:
       github:
         command: npx
         args: ["-y", "@modelcontextprotocol/server-github"]
         env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
   ```

2. Point your MCP client at the gateway, for example in Claude Code:

   ```sh
   claude mcp add adtl -- npx -y @adtl/gateway --config /absolute/path/to/adtl.yaml
   ```

3. Your agent now sees the upstream tools as `github__get_issue`, `github__add_comment`, and so on. When a call is stopped, the agent receives an error result that explains why.

## Configuration

One file holds both the labels and the gateway settings.

### Labels: what each tool returns, and where it can send data

| Key | Values | Meaning |
|---|---|---|
| `integrity` | `trusted`, `untrusted` | Can the tool's *result* be trusted to influence actions? Content from strangers (issues, emails, web pages) is untrusted. |
| `confidentiality` | `public`, `private`, `secret` | Who may see the tool's *result*? |
| `egress` | `none`, `internal`, `external`, `public` | Where *calling* the tool can send data. |

Tools without a rule use the defaults (`untrusted`, `private`, egress `unknown`). That's safe but strict, so describe the tools you use. Resources and prompts use the server's `defaults`.

#### Drafting rules with `init`

List your servers under `gateway.upstreams`, then let `init` draft a rule for every tool:

```sh
adtl-gateway init -c adtl.yaml           # print the updated config, change nothing
adtl-gateway init -c adtl.yaml --write   # update the file (original kept as adtl.yaml.bak)
```

`init` connects to each upstream and lists its tools.

- **Presets** cover the GitHub (`github-mcp-server`), filesystem and fetch servers. A preset says what the server's reads and writes mean; the server's `readOnlyHint` decides which tools are reads, so new tools are covered too.
- **Other servers** get rules from their MCP tool hints. Hints only set egress, because they are the server's own claims: every result stays `untrusted` and `private` until you change it. These lines are marked `review`.
- Entries already in the file are never changed, so you can re-run `init` after a server adds tools. Tools the server no longer offers are reported, not removed.
- Edits keep your comments, but the YAML may be reformatted slightly (e.g. `[a]` becomes `[ a ]`).

Always review the result: a preset is a starting point, not a judgment about your data.

#### Starting from Claude Code's `.mcp.json`

If your servers are already set up in Claude Code, import them:

```sh
adtl-gateway init -c adtl.yaml --from .mcp.json           # print both files, change nothing
adtl-gateway init -c adtl.yaml --from .mcp.json --write   # write them (originals kept as .bak)
```

- Every stdio and HTTP server in `.mcp.json` becomes an upstream, with its command, args, env, url and headers. `${VAR}` and `${VAR:-default}` keep working, because the gateway expands them the same way. Names that aren't valid upstream ids are adjusted (`docs.api` becomes `docs-api`).
- `adtl.yaml` is created if it doesn't exist, with restrictive defaults and the two example policy rules; then rules are drafted for every tool as above.
- With `--write`, the imported servers in `.mcp.json` are replaced by one `adtl` entry that runs `npx -y @adtl/gateway@<version> --config adtl.yaml`. Everything else in the file is kept. Restart Claude Code afterwards.
- SSE servers stay in `.mcp.json`, because the gateway only speaks Streamable HTTP. So do entries that already run the gateway, and upstreams already in `adtl.yaml` are never changed. Re-running is safe.
- Any file with `mcpServers` works, such as Claude Desktop's `claude_desktop_config.json`. Servers added with `claude mcp add` live in `~/.claude.json` instead; list them with `claude mcp list`.

The gateway starts upstream servers with a minimal environment plus their `env:` entries, not your whole shell environment. If a server relied on a variable from your shell, add it under its `env:`, e.g. `GITHUB_TOKEN: "${GITHUB_TOKEN}"`.

Labels only get stricter as a session goes on. A session that has read anything untrusted stays untrusted until the session ends.

### Policy

Rules match on `session.integrity`, `session.confidentiality`, `tool.egress` and `tool` (`server.tool` globs such as `github.*`), and decide `allow`, `ask` or `block`. When several rules match, the most restrictive decision wins. `ask` waits for a human when [approvals](#approvals) are configured, and blocks otherwise.

### Gateway

| Key | Meaning |
|---|---|
| `gateway.upstreams.<id>` | A stdio server (`command`, `args`, `env`, `cwd`) or an HTTP server (`url`, `headers`). The `<id>` must match the key under `servers:`. |
| `gateway.audit` | Path of a JSONL audit log, relative to the config file |
| `gateway.mode` | `active` (default) or `audit`. See [Trying a policy safely](#trying-a-policy-safely). |
| `gateway.approvals` | Ask a human about `ask` decisions. See [Approvals](#approvals). |
| `gateway.interceptorTimeoutMs` | Timeout per interceptor call (default 5000) |
| `gateway.interceptors` | Custom interceptor server command (default: the bundled `@adtl/interceptors`) |

`${VAR}` in commands, args, env, URLs and headers is read from the environment, so secrets stay out of the file.

### Approvals

With approvals configured, an `ask` decision holds the call and sends you a push notification with **Allow** and **Deny** buttons. Allow runs the call; Deny, or no answer before the timeout, stops it.

```yaml
gateway:
  approvals:
    timeoutSeconds: 50              # no answer means deny (default 50)
    ntfy:
      topic: ${ADTL_NTFY_TOPIC}     # a long random name; subscribe to it in the ntfy app
      # server: https://ntfy.example.com   # default https://ntfy.sh
      # token: ${NTFY_TOKEN}               # for access-controlled topics
    email:                          # optional, notify only
      smtp: { host: smtp.example.com, port: 465, user: "${SMTP_USER}", pass: "${SMTP_PASS}" }
      from: adtl@example.com
      to: you@example.com
      on: [pending, blocked]        # also: approved, denied, timeout, undeliverable
```

Setup: install the [ntfy app](https://ntfy.sh), subscribe to your topic, and set `ADTL_NTFY_TOPIC` in the gateway's environment, for example in Claude Code's `.mcp.json` `env`.

How it works and what to know:

- **No open ports.** The buttons post your answer to a reply topic (`<topic>-reply`) on the same ntfy server, and the gateway listens there.
- **Answers are signed.** Each button carries a token that only answers that one call (it's bound to the call's hash), only once, and only until it expires. Forged, reused or late answers are ignored.
- **Keep the topic private.** Anyone who can read your topic can press your buttons. Use a long random topic name on ntfy.sh, or an access-controlled topic on your own ntfy server.
- **Nothing sensitive is sent.** Notifications and emails name the tool, the server and the reason, never the call's arguments or results.
- **Email never contains approve links,** because mail security scanners open links automatically and would approve calls by themselves.
- **Mind client timeouts.** Many MCP clients give up on a request after 60 seconds, so the default timeout is 50. The gateway sends progress notifications while it waits, which lets clients that reset their timeout on progress wait longer.
- **Every outcome is logged.** The audit log records `approval: { outcome, channel, waitedMs }` for each call that was asked.

### Trying a policy safely

Run in audit mode first to see what your policy would stop, without stopping anything:

```sh
adtl-gateway --config adtl.yaml --audit
```

or set `gateway.mode: audit` in the file. In audit mode every call goes through and results are not changed. Labels are still tracked, so the decisions are the same as in active mode. Each line in the audit log gets `"mode": "audit"`, and a call the policy would have stopped is logged as `"outcome": "forwarded"` with `"decision": "ask"` or `"block"`, the reason and the matching rules. Once the log looks right, remove the flag.

## Claude Code: cover the built-in tools too

The gateway only sees MCP calls. Claude Code's own tools (`WebFetch`, `WebSearch`, `Bash`, `Read`, ...) don't go through it, so a page fetched with `WebFetch` would not taint the session, and `Bash` could send data anywhere. `adtl-gateway hook` closes that gap. Add it to `.claude/settings.json` (or `~/.claude/settings.json` for every project):

```json
{
  "hooks": {
    "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "npx -y @adtl/gateway hook --config /absolute/path/to/adtl.yaml", "timeout": 10, "onFailure": "block" }] }],
    "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "npx -y @adtl/gateway hook --config /absolute/path/to/adtl.yaml", "timeout": 10 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "npx -y @adtl/gateway hook --config /absolute/path/to/adtl.yaml", "timeout": 10 }] }]
  }
}
```

(A global install, `npm i -g @adtl/gateway` and then `adtl-gateway hook ...`, starts faster than `npx`.)

What it does:

- **After each tool runs**, it labels the output and adds it to the session label. Built-in tools are labeled as the server `claude-code`.
- **Before each tool runs**, it checks the call against the same policy as the gateway. `block` denies the call. `ask` shows Claude Code's own permission prompt, so you approve in the terminal. `allow` gives no answer, so your normal Claude Code permissions still apply. ADTL never approves a call on its own.
- **It shares one session label with the gateway.** Claude Code gives the gateway its session id (`CLAUDE_CODE_SESSION_ID`), and both keep the label in `~/.adtl/sessions/<id>.jsonl` (set `ADTL_SESSIONS_DIR` to change the directory). A `WebFetch` taints the session for `github__add_comment`, and a private file read through the gateway counts against a later `Bash` call. Labels last for the whole Claude Code session, including `--resume`.
- **It covers MCP servers that skip the gateway**, such as connectors added in claude.ai. Their tools are labeled as their server name (`mcp__<server>__<tool>` → server `<server>`), so you can describe them under `servers:` like any upstream. The gateway's own tools (`mcp__adtl__*`) are skipped; pass `--gateway-server <name>` if you registered the gateway under another name.
- **It fails closed.** If the hook can't decide, it exits with code 2, which stops the call.
- **It writes to the same audit log** (`gateway.audit`) with `"via": "claude-code-hook"`, and follows `gateway.mode: audit`. The config needs no `gateway:` section if you only use the hooks.

Built-in labels, which you can override under `servers.claude-code.tools`:

| Tools | Result | Egress |
|---|---|---|
| `Read`, `Grep`, `Glob` | trusted, private | none |
| `WebFetch`, `WebSearch` | untrusted, public | external (a URL or query can carry data out) |
| `Bash`, `Monitor` | unknown, private | unknown |
| `Agent` / `Task` | unknown, private | none (the sub-agent's own calls are checked too) |
| `Write`, `Edit`, `TodoWrite`, other bookkeeping tools | trusted, public | none |
| anything else | your `defaults` | unknown |

With the [example policy](../../examples/adtl.yaml), `Bash` and `WebFetch` run freely in a fresh session, but ask first once the session has read untrusted content, because `no-public-write-after-untrusted` matches `tool.egress: [public, external, unknown]`.

The hook also refuses `Write` and `Edit` on your ADTL config and session files, and asks before shell commands that mention the session directory, so the agent can't simply clear its own taint. This is a speed bump, not a sandbox.

## How it works

```
agent ──▶ adtl-gateway ──▶ upstream MCP servers
              │
              └─▶ adtl-interceptors (separate process, SEP-2624)
                    adtl.policy  checks the call before it runs
                    adtl.label   labels the result after it returns
```

The gateway fails closed. If an interceptor errors or times out, the call is stopped. If a result can't be labeled, it is withheld. If the interceptors are missing, the gateway refuses to start. (In audit mode such failures are logged as warnings instead.)

## Limits of this version

- Tools, resources and prompts are proxied. Resource subscriptions, `list_changed` notifications and completions are not passed through yet.
- Resources and prompts are labeled by server defaults (`servers.<id>.defaults`) or the global defaults; there are no per-resource or per-prompt rules yet. A resource URI that two upstreams could serve is refused rather than guessed.
- Approvals come from one push channel (ntfy). Other channels, approvals inside the MCP client, and approver roles are planned.
- Labels last for one agent session: one gateway process, or under Claude Code one Claude Code session (shared with the hooks). They are not carried into files, memory or other agents yet; that's planned for v0.4. A file written after reading untrusted content reads back as trusted.
- The Claude Code hooks label tools by name, not by what they touched: a `Read` of a downloaded file is as trusted as a `Read` of your own code.
- Labels are set by your config. Servers' own trust claims can only make labels stricter, unless you set `acceptServerClaims: true`.

## Links

- Repository, demo and examples: https://github.com/probita-ai/adtl
- Related packages: [`@adtl/interceptors`](https://www.npmjs.com/package/@adtl/interceptors), [`@adtl/labels`](https://www.npmjs.com/package/@adtl/labels)

License: Apache-2.0
