# `adtl.label.v1`: a trust-annotations scheme

> **Experimental scheme draft, seeking feedback.** This proposes `adtl.label.v1` as a data-labelling scheme for the `evidenceRef` slot of MCP's draft [`trust-annotations`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations) extension. It is not an MCP extension and changes nothing in the `trust-annotations` wire shape. ADTL is a personal open-source project; this document is not endorsed by the Tool Annotations Interest Group.

**Scheme**: fills `trust-annotations`'s `evidenceRef` slot, selected by `evidenceRef.type == "adtl.label.v1"`. Not an extension.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

## Abstract

`adtl.label.v1` carries an information-flow label for one MCP result: an integrity level, a confidentiality level, and the origins the data came from. A host can join these labels across a session and check them before an egress tool call: allow it, block it, or ask a human.

ADTL already emits this type on every result it labels (tools, resources and prompts). This document describes that behavior so the `type` value can be coordinated in the scheme registry kept in [`schemes/`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations/tree/main/schemes).

## The ask

I'd like the IG's go-ahead to open a docs-only PR against `experimental-ext-tool-annotations`:

| File | Change |
| --- | --- |
| `schemes/adtl-label.md` | This document, as a scheme doc |
| `schemes/README.md` | One row in the "Schemes here" table |
| `README.md` | One row in the data-labelling schemes table |
| `docs/decisions.md` | An appended entry, only if the IG wants one |

Out of scope: ADTL's convention for carrying labels on records in memory stores. It bears on the parked question of taint persistence across the store boundary, and would be brought separately.

## Specification

### Scheme identity

This scheme is selected by `evidenceRef.type == "adtl.label.v1"` on a `trust-annotations` annotation. A client that does not implement it MUST be able to ignore it safely: the `untrusted` and `sensitive` booleans and the `digest` / `canonicalization` pair stay meaningful on their own.

### On the wire

A result as ADTL emits it today:

```json
{
  "content": [ ... ],
  "_meta": {
    "io.modelcontextprotocol/trust-annotations": {
      "untrusted": true,
      "sensitive": true,
      "evidenceRef": {
        "type": "adtl.label.v1",
        "digest": "sha256:…",
        "canonicalization": "jcs/rfc8785"
      }
    },
    "adtl/label": {
      "integrity": "untrusted",
      "confidentiality": "private",
      "origins": [
        { "server": "github", "tool": "issue_read" },
        { "server": "github", "tool": "get_file_contents" }
      ]
    }
  }
}
```

The record also travels inline under ADTL's own `_meta` key, `adtl/label`. ADTL does not yet emit the recommended `schema` field; the scheme PR would add it.

### Label payload

| Field | Required | Values | Meaning |
| --- | --- | --- | --- |
| `integrity` | yes | `untrusted` < `unknown` < `trusted` | Can this data be trusted to influence actions? |
| `confidentiality` | yes | `public` < `private` < `secret` | Who may see it? |
| `origins` | yes | array of `{ server, tool? \| resource? \| prompt? }` | Where the data came from, for audit and policy. Producers SHOULD cap it; ADTL keeps the newest 64 |

`server` is the upstream server's id as the host names it, not a global identifier.

### Mapping to the floor

A producer MUST set both booleans whenever it emits this scheme, so a client that ignores the scheme still gets the floor:

| Label | `untrusted` | `sensitive` |
| --- | --- | --- |
| `integrity: trusted` | `false` | |
| `integrity: unknown` or `untrusted` | `true` | |
| `confidentiality: public` | | `false` |
| `confidentiality: private` or `secret` | | `true` |

`unknown` maps to `untrusted: true` on purpose: a result nobody vouched for is treated as untrusted on the wire.

### Digest

`digest` is `sha256:` followed by the lowercase hex SHA-256 of the record, canonicalized with JCS ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)). `canonicalization` MUST be `jcs/rfc8785`. A client holding the record can re-derive the digest and MUST treat a mismatch as if no record were present.

### Label semantics

- **Join.** Combining labels takes the lowest integrity and the highest confidentiality, and the union of origins. A session's label is the join of everything it has read, so it only gets stricter.
- **Coarse confidentiality.** `private` joined with `private` stays `private`. Unlike [`ifc.fides.v1`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations/blob/main/schemes/ifc-fides.md), this scheme does not resolve reader sets. A host that needs precise cross-source decisions SHOULD use FIDES-style resolution instead.
- **Blocks only restrict.** A content-block annotation MAY make the result's label stricter and MUST NOT relax it.
- **Declassification** is a host decision outside this scheme. A host that relaxes a label SHOULD record who did it and why.
- **Policy before egress.** Before an egress tool call, the host checks the session label against its policy. ADTL's outcomes are `allow`, `ask` (a human confirms) and `block`.

### Trusting the producer

A label from a server is a claim, not a fact. A consumer:

- MAY accept claims that make a label stricter from any server.
- MUST NOT accept claims that relax a label unless the user has allowlisted that server, and SHOULD let the user's own labeling rules take precedence.
- When no label is present, SHOULD fall back to its own rule for that tool, and otherwise to a restrictive default. ADTL uses the tool's `openWorldHint`, then `untrusted` + `private`.

## Relationship to `ifc.fides.v1`

This scheme is close to FIDES but does not fit inside it, so it is proposed as a sibling `type` rather than a change to FIDES.

| | `ifc.fides.v1` | `adtl.label.v1` |
| --- | --- | --- |
| Integrity | 2 levels | 3 levels, adds `unknown` |
| Confidentiality | `public` / `private` | adds `secret` |
| `private` joined with `private` | Host resolves reader sets | Stays `private` |
| Provenance | none in the record | `origins` |
| Absent label | host's default policy | host's rule for that tool, else restrictive |

A host can map an `adtl.label.v1` label down to FIDES: `unknown` becomes `untrusted` and `secret` becomes `private`. A FIDES label maps into this scheme without loss, apart from reader-set resolution.

## Graceful degradation

- A client that knows neither scheme acts on the two booleans.
- A client that knows `ifc.fides.v1` but not this scheme can ignore it, or map it down as above.
- An unknown `evidenceRef.type` is ignorable by the `trust-annotations` rules, so emitting this scheme never breaks a client.

## Reference implementation

All in [probita-ai/adtl](https://github.com/probita-ai/adtl) (TypeScript, Apache-2.0), v0.7.0:

- **Codec**: `attachLabel` and `readClaims` in [`@adtl/labels`](packages/labels/src/trustAnnotations.ts).
- **Producer**: the `adtl.label` interceptor, a [SEP-2624](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2624) mutator in [`@adtl/interceptors`](packages/interceptors).
- **Consumer**: the `adtl.policy` validator and the [`@adtl/gateway`](packages/gateway), which allow, block or ask a human.
- **Evidence**: the exfiltration attack replayed against [GitHub's real MCP server](examples/github-real-demo), where the label blocks posting private file contents to a public issue.

## Questions for the IG

1. Is a project-specific `type` like `adtl.label.v1` welcome in `schemes/`, or should the registry hold only models with a paper or SEP behind them?
2. Sibling type, or a FIDES profile (for example `ifc.fides.v1` with an extension field for `unknown`, `secret` and origins)?
3. Is carrying the record inline under a project `_meta` key (`adtl/label`) acceptable, or should it move behind `evidenceRef.ref`, following the FIDES lean that `evidenceRef` is canonical?
4. Should the value be named after the project (`adtl.label.v1`) or after what it models (for example `ifc.lattice3.v1`)?

Feedback is welcome in the Tool Annotations IG Discord channel or as an [issue](https://github.com/probita-ai/adtl/issues).

## Changelog

| Date | Change |
| --- | --- |
| 2026-10-30 | First draft |
