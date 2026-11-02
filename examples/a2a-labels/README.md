# Trust labels over A2A

Two agents pass a summary over [A2A](https://a2a-protocol.org). The researcher read a stranger's GitHub issue, so its session is untrusted. With the [ADTL A2A extension](../../docs/a2a-trust-labels-v1.md), the summary carries that label, signed by the researcher's gateway key. The publisher joins it into its own session, so its policy asks before posting publicly. A message edited in transit no longer verifies and is treated as untrusted and private.

```sh
npm install && npm run build
node examples/a2a-labels/demo.mjs
```

```
publisher before the message: allow
label on the message: verified, untrusted/public
publisher after the message:  ask (Rule "no-public-write-after-untrusted" requires ask)
tampered message: invalid (parts changed after the label was signed), treated as untrusted/private
```

The demo uses `@adtl/labels` directly, with no A2A SDK, so it shows only the label handling. In a real deployment, the sending agent's gateway signs outgoing messages and artifacts, and the receiving agent's gateway reads them before the agent sees them.
