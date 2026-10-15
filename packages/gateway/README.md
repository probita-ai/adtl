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

Tools without a rule use the defaults (`untrusted`, `private`, egress `unknown`). That's safe but strict, so describe the tools you use.

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
- Labels last for one gateway process, which is one agent session. They are not carried into files, memory or other agents yet; that's planned for v0.4.
- Labels are set by your config. Servers' own trust claims can only make labels stricter, unless you set `acceptServerClaims: true`.

## Links

- Repository, demo and examples: https://github.com/probita-ai/adtl
- Related packages: [`@adtl/interceptors`](https://www.npmjs.com/package/@adtl/interceptors), [`@adtl/labels`](https://www.npmjs.com/package/@adtl/labels)

License: Apache-2.0
