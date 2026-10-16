# Demo: a delayed prompt injection, written Monday, triggered Tuesday

```sh
npm install
npm run demo:ledger
```

## The attack

On Monday an agent fetches a web page for you. The page hides an instruction for AI agents, and the agent saves the page into `notes.md`. Nothing bad happens that day.

On Tuesday you start a fresh session and ask it to look at yesterday's notes. It reads `notes.md`, finds the instruction and posts the attacker's link as a public comment.

Session labels alone can't stop this. Tuesday's session never saw the web page, and reading your own files is trusted.

## What the demo does

It runs the real processes twice: the Claude Code hook (`adtl-gateway hook`) for `WebFetch`, `Write` and `Read`, and `adtl-gateway` with the [fake GitHub server](../fake-github/server.mjs) for the comment.

| Run | Tuesday's `Read` of notes.md | Result |
|---|---|---|
| 1, session labels only | trusted | The link is posted |
| 2, with the label ledger | untrusted, written by session `mon` | The post is stopped |

In run 2, Monday's session was untrusted when it wrote `notes.md`, so the ledger recorded the text with that label. On Tuesday the hook looks up the file's content, finds it, and the session becomes untrusted. The example policy's `no-public-write-after-untrusted` rule then asks before `post_comment`, and with no approval channel configured the call is stopped.

The "agent" is a script that always follows instructions it finds. Real models often resist this kind of injection, but ADTL is meant to hold even when they don't.
