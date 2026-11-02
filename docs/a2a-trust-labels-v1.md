# A2A extension: trust labels (draft v1)

> **Experimental draft, seeking feedback.** A personal open-source project, not an A2A or Linux Foundation specification. Implemented in [`@adtl/labels`](../packages/labels) (`signA2ALabel`, `readA2ALabel`). Comments welcome as [issues](https://github.com/probita-ai/adtl/issues).

**Extension URI:** `https://github.com/probita-ai/adtl/blob/main/docs/a2a-trust-labels-v1.md`

The key words MUST, MUST NOT, SHOULD and MAY are to be read as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Why

An agent that reads a stranger's GitHub issue, or a private file, carries that into everything it writes afterwards. In MCP, [ADTL](../README.md) tracks this as a session label: integrity (can the data be trusted to drive actions?) and confidentiality (who may see it?). When an agent hands work to another agent over A2A, the label is lost: the receiver sees clean text and may act on an injected instruction, or post private data publicly.

This extension carries the sender's label with each A2A Message and Artifact, so the receiving agent starts from what the sender had seen.

## Declaring support

An agent that sends or accepts labels lists the extension in its Agent Card:

```json
"capabilities": {
  "extensions": [
    {
      "uri": "https://github.com/probita-ai/adtl/blob/main/docs/a2a-trust-labels-v1.md",
      "description": "Signed integrity and confidentiality labels on messages and artifacts",
      "required": false
    }
  ]
}
```

`required` SHOULD be `false`: a client that doesn't know the extension still works, and its messages count as unlabeled (see [Receiving](#receiving)). A receiver MAY set it to `true` to refuse unlabeled work.

A Message that carries a label MUST list the URI in its `extensions` array.

## The label

The label goes in the `metadata` of a Message or an Artifact, under the extension URI:

```json
{
  "kind": "message",
  "role": "agent",
  "messageId": "9f2c…",
  "parts": [{ "kind": "text", "text": "Here is the summary of issue #12…" }],
  "extensions": ["https://github.com/probita-ai/adtl/blob/main/docs/a2a-trust-labels-v1.md"],
  "metadata": {
    "https://github.com/probita-ai/adtl/blob/main/docs/a2a-trust-labels-v1.md": {
      "label": {
        "integrity": "untrusted",
        "confidentiality": "private",
        "origins": [{ "server": "github", "tool": "issue_read" }, { "server": "github", "tool": "get_file_contents" }]
      },
      "partsDigest": "sha256:…",
      "issuedAt": "2026-11-01T10:00:00.000Z",
      "signer": "ed25519:…",
      "signature": "…"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `label.integrity` | `untrusted` < `unknown` < `trusted` |
| `label.confidentiality` | `public` < `private` < `secret` |
| `label.origins` | Where the data came from: `{ server, tool? \| resource? \| prompt? }`. For audit and policy. |
| `partsDigest` | `sha256:` + lowercase hex SHA-256 of the JCS-canonical ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) `parts` array. Binds the label to this content. |
| `issuedAt` | When the sender signed it (ISO 8601, UTC). |
| `signer` | The sender's Ed25519 public key: `ed25519:` + base64url of the 32-byte key. |
| `signature` | Base64url Ed25519 signature over the JCS-canonical object `{ label, partsDigest, issuedAt, signer }`, plus `messageId` for a Message or `artifactId` for an Artifact. |

The label is the same object as ADTL's [`adtl.label.v1`](../SPEC.md) record, so a label read from an MCP tool result can be passed on unchanged.

## Sending

- The sender MUST label every Message and Artifact with its session label at the time it sends them: the join of everything the agent has read, not just the inputs to this reply. An agent's output mixes everything in its context.
- Labels only get stricter as data flows. A sender MUST NOT send a label less strict than its session label, unless a human declassified it.
- The sender SHOULD sign with a key the agent itself can't read, for example one held by the gateway process.

## Receiving

The receiver computes the label to use for the object, then joins it into its own session label (lowest integrity, highest confidentiality, union of origins).

| What arrived | Label to use |
| --- | --- |
| A valid label signed by a key the receiver trusts for this sender | The label as sent |
| A valid label signed by any other key | The join of the label and the receiver's default for this sender: it can only make things stricter |
| No label | The receiver's default for this sender |
| A malformed label, a `partsDigest` that doesn't match `parts`, or a signature that doesn't verify | The join of the receiver's default and `untrusted` + `private` |

- The receiver's default for an unknown sender SHOULD be `untrusted` + `private`.
- A receiver MUST NOT treat a label from an untrusted key as relaxing its default, since anyone can sign a clean label.
- A receiver MUST NOT strip or relax the label of an Artifact it forwards.

## Security considerations

- **A signature says who labeled the message, not that the label is right.** A sender that lies about its label (claims `trusted` after reading an issue) defeats the extension. Only trust keys of gateways you run or audit.
- **Replay.** A valid message can be replayed with its label. The label only ever makes the receiver stricter unless the key is trusted, so replay can't relax anything for untrusted senders. Receivers that trust a key MAY reject old `issuedAt` values.
- **Tampering.** Changing `parts`, `messageId` or `artifactId`, or the label itself, breaks the signature, and the receiver falls back to a restrictive label.
- **Confidentiality is coarse.** `private` doesn't say who may read the data; there are no reader sets. See ADTL's [FIDES mapping](../packages/gateway#fides-and-fides-gateway) for systems that have them.

## Reference implementation

[`@adtl/labels`](../packages/labels) (TypeScript, Apache-2.0):

```ts
import { loadOrCreateSigner, readA2ALabel, signA2ALabel } from "@adtl/labels";

const signer = loadOrCreateSigner();                      // ~/.adtl/signing-key.pem
const sent = signA2ALabel(message, sessionLabel, signer); // sender

const { label, status, reason } = readA2ALabel(received, { trustedKeys: ["ed25519:…"] }); // receiver
sessions.observe(sessionId, label);
```

See [`examples/a2a-labels`](../examples/a2a-labels) for two agents passing a tainted summary.

## Open questions

1. Should the label live in `metadata` (as here), or in a dedicated field once A2A extensions can add fields?
2. Should Tasks carry a label of their own, or is the label of their latest Message and Artifacts enough?
3. Should `partsDigest` cover `FilePart` bytes fetched by URI, not just the part as sent?
4. Is Ed25519 + JCS the right default, or should the extension use JWS like the A2A Agent Card signatures?

## Changelog

| Date | Change |
| --- | --- |
| 2026-11-01 | First draft |
