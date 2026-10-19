# @adtl/ledger

> **Experimental.** Part of [ADTL](https://github.com/probita-ai/adtl), built on draft MCP proposals that are still changing. Not a security guarantee.

The label ledger: labels that follow the data, not the process.

Session labels end with the session. If an agent reads an untrusted web page and writes part of it to `notes.md`, a fresh session that reads `notes.md` tomorrow sees "your own file" and trusts it. The ledger closes that gap:

- **Record.** When a session that has read untrusted or private data sends text anywhere (a file, a memory server, a sub-agent prompt, an issue comment), the text's chunk hashes are stored with that session's label. Clean sessions record nothing.
- **Look up.** Before a result reaches the agent, its chunk hashes are looked up. Any matching label is joined into the result's label, with an origin naming the session that wrote it.
- **Declassify.** A person can clear the label of specific content after checking it.

Text is normalized (Unicode NFC, lowercase, whitespace collapsed) and hashed whole, per paragraph and per line, skipping pieces under 32 characters. A paragraph copied into a bigger file still matches. Text the agent rewrote is caught too, because it was written by the tainted session. Text a person rewrote by hand is not, and neither is text a server rewrote after it was sent: memory servers that extract facts with a model on write, or merge records, store sentences the session never sent, so they match nothing.

Entries live in one SQLite file (`node:sqlite`, no native dependency), hash-chained so edits and deletions are detectable, and pruned after 90 days by default.

```ts
import { Ledger, chunkHashes } from "@adtl/ledger";

const ledger = new Ledger("/tmp/ledger.db");
ledger.record(chunkHashes(webPageText), { integrity: "untrusted", confidentiality: "public", origins: [] }, "session-monday");

ledger.lookup(chunkHashes(notesFileText))?.label.integrity; // "untrusted"
ledger.verify(); // { ok: true, entries: … }
```

`@adtl/interceptors` and `@adtl/gateway` (including its Claude Code hooks) use it automatically; see the [gateway docs](../gateway#label-ledger).

Requires Node.js 22.13 or later.
