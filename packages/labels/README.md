# @adtl/labels

> **Experimental.** Follows MCP's draft [trust-annotations](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations) extension, which is still changing. Not a security guarantee.

The core of ADTL, with no MCP transport and no I/O:

- **Labels**: integrity (`trusted` / `unknown` / `untrusted`), confidentiality (`public` / `private` / `secret`), and origins. Combining labels keeps the lowest integrity and the highest confidentiality, so a label only gets stricter.
- **trust-annotations codec**: reads and writes `_meta["io.modelcontextprotocol/trust-annotations"]` following the draft's rules. An absent field means "no claim". A content block can add restrictions but never remove them.
- **Labeling rules**: your config decides labels. Servers' own claims can make labels stricter, and can relax them only when the server is allowlisted.
- **Policy evaluation**: `allow` / `ask` / `block`. The most restrictive matching rule wins.
- **Call hashing**: canonical JSON (RFC 8785 style) and SHA-256, so a decision is bound to one exact call.

```ts
import { InMemorySessionStore, evaluatePolicy, labelResult, parseConfig, toolEgress } from "@adtl/labels";

const config = parseConfig({
  servers: { github: { tools: { read_issue: { integrity: "untrusted", confidentiality: "public" }, post_comment: { egress: "public" } } } },
  policy: { rules: [{ name: "no-public-after-untrusted", when: { "session.integrity": "untrusted", "tool.egress": "public" }, then: "ask" }] },
});

const sessions = new InMemorySessionStore();
sessions.observe("s1", labelResult({ server: "github", tool: "read_issue", result: { content: [] } }, config));

evaluatePolicy(config.policy, {
  session: sessions.get("s1"),
  server: "github",
  tool: "post_comment",
  egress: toolEgress(config, "github", "post_comment"),
}).decision; // "ask"
```

License: Apache-2.0 · https://github.com/probita-ai/adtl
