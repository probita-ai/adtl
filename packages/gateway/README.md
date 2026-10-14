# @adtl/gateway

> **Experimental.** ADTL is a personal open-source project built on draft MCP proposals ([trust-annotations](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations), [SEP-2624 interceptors](https://github.com/modelcontextprotocol/experimental-ext-interceptors)) that are still changing. It is not a security guarantee: don't rely on it to protect production systems yet. Feedback is very welcome.

An MCP gateway for AI agents. It sits between your agent (Claude Code, Cursor, any MCP client) and your MCP servers, and:

- **labels every tool result**: where it came from, whether it can be trusted, how sensitive it is (MCP's draft `trust-annotations` format)
- **checks every tool call** against what the session has already seen: allow, ask, or block
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

Rules match on `session.integrity`, `session.confidentiality`, `tool.egress` and `tool` (`server.tool` globs such as `github.*`), and decide `allow`, `ask` or `block`. When several rules match, the most restrictive decision wins. In this version `ask` is treated as `block`; approvals are planned for v0.2.

### Gateway

| Key | Meaning |
|---|---|
| `gateway.upstreams.<id>` | A stdio server (`command`, `args`, `env`, `cwd`) or an HTTP server (`url`, `headers`). The `<id>` must match the key under `servers:`. |
| `gateway.audit` | Path of a JSONL audit log, relative to the config file |
| `gateway.mode` | `active` (default) or `audit`. See [Trying a policy safely](#trying-a-policy-safely). |
| `gateway.interceptorTimeoutMs` | Timeout per interceptor call (default 5000) |
| `gateway.interceptors` | Custom interceptor server command (default: the bundled `@adtl/interceptors`) |

`${VAR}` in commands, args, env, URLs and headers is read from the environment, so secrets stay out of the file.

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

- Only tools are proxied. Resources and prompts are not passed through yet.
- `ask` blocks instead of asking. Human approvals are planned for v0.2.
- Labels last for one gateway process, which is one agent session. They are not carried into files, memory or other agents yet; that's planned for v0.3.
- Labels are set by your config. Servers' own trust claims can only make labels stricter, unless you set `acceptServerClaims: true`.

## Links

- Repository, demo and examples: https://github.com/probita-ai/adtl
- Related packages: [`@adtl/interceptors`](https://www.npmjs.com/package/@adtl/interceptors), [`@adtl/labels`](https://www.npmjs.com/package/@adtl/labels)

License: Apache-2.0
