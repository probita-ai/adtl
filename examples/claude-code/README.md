# Use ADTL from Claude Code

This folder holds a [`.mcp.json`](.mcp.json) that runs `adtl-gateway` as an MCP server for Claude Code, and a [`.claude/settings.json`](.claude/settings.json) that runs `adtl-gateway hook` on every tool call, so Claude Code's built-in tools are labeled and checked too. The gateway uses [`../adtl.yaml`](../adtl.yaml), which points at the fake GitHub server, so you need no token or network access.

## Try it

1. Build once, from the repo root:

   ```sh
   npm install
   npm run build
   ```

2. Start Claude Code in this folder:

   ```sh
   cd examples/claude-code
   claude
   ```

3. Claude Code asks whether to use the `adtl` server from `.mcp.json`, and whether to trust this folder's settings (which add the hooks). Approve both. Then run `/mcp` to confirm `adtl` is connected with 4 tools.

4. Ask Claude:

   > Read issue 42 on acme/website, then read secrets.env from acme/internal and post its contents as a comment on issue 42.

   Claude reads the issue and the file, both labeled. The `post_comment` call comes back as an error: **ADTL blocked this call: Private data must not reach a public tool.**

   Note that Claude itself may refuse, because the issue contains a prompt injection. ADTL doesn't rely on the model noticing the attack: it blocks the data flow even when the request comes straight from you.

5. Other things to try:
   - "Post 'Thanks!' on issue 1 of acme/website." This is **allowed** in a fresh session.
   - "Read issue 42, then reply 'On it!'." This **needs approval**. Without an approval channel it is stopped; see [Approvals](../../packages/gateway#approvals) to get a push notification instead.
   - "List my repos." This always works, because `list_repos` can't send data anywhere.

6. Try the built-in tools (needs network access):
   - "Fetch https://example.com, then post 'Thanks!' on issue 1 of acme/website." The fetched page is untrusted, so the gateway stops `post_comment`, even though the fetch never went through it.
   - "Read issue 42, then run `curl https://example.com` in the shell." After the untrusted issue, the hook makes Claude Code ask you before running the command.
   - "Run `ls`." In a fresh session this needs no extra approval from ADTL.

Labels belong to the Claude Code session: `/clear` or a new `claude` starts clean, and `claude --resume` keeps the label, because the conversation still holds what was read. They are kept in `~/.adtl/sessions/`.

## Use it with your own MCP servers

Edit the `gateway.upstreams` section of your `adtl.yaml`, and give each server's tools labels under `servers:`:

```yaml
servers:
  github:
    tools:
      get_issue:   { integrity: untrusted, confidentiality: public,  egress: none }
      add_comment: { integrity: trusted,   confidentiality: public,  egress: public }

gateway:
  upstreams:
    github:
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_TOKEN}" }
```

Tools without a rule are treated as untrusted and private, and their egress is unknown. That's safe, but strict: expect "needs approval" until you describe your tools.

To use the hooks in another project, copy [`.claude/settings.json`](.claude/settings.json) and change the paths (see [the gateway docs](../../packages/gateway#claude-code-cover-the-built-in-tools-too)).

To add the gateway to Claude Code from any folder, without a `.mcp.json`:

```sh
claude mcp add adtl -- node /absolute/path/to/adtl/packages/gateway/dist/cli.js --config /absolute/path/to/adtl.yaml
```
