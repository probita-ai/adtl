# FIDES interop check

Checks that the labels ADTL emits with `fides: { emit: true }` mean the same thing to Microsoft's [fides-gateway](https://github.com/microsoft/fides-gateway) as they do to ADTL. It uses fides-gateway's own Pydantic models and the label resolution its policy engine uses, so it runs against your local checkout of fides-gateway. It is not part of `npm test`.

```sh
# 1. In this repo: build, and write the samples
npm run build
node examples/fides-interop/samples.mjs > /tmp/adtl-fides-samples.json

# 2. In a fides-gateway checkout (Python 3.11+), with its dependencies installed
git clone https://github.com/microsoft/fides-gateway && cd fides-gateway
uv sync --extra dev                      # or: pip install -e '.[dev]'
uv run python /path/to/adtl/examples/fides-interop/check.py /tmp/adtl-fides-samples.json
```

Expected output: one `ok` line per label, then `all samples match`.

What it checks, for four labels (trusted/public, untrusted/public, unknown/private, untrusted/secret):

- **Requests**: the `_meta["com.github.ifc/labels"]` ADTL puts on an outgoing tool call validates as fides-gateway's `LabeledToolCallParams`, and the effective label of `$['name']`, `$['arguments']` and a nested argument is the label ADTL meant.
- **Results**: a labeled result validates as `LabeledToolResult`, and every label on it equals the expected one.

How labels map (see [`packages/labels/src/fides.ts`](../../packages/labels/src/fides.ts)):

| ADTL | fides-gateway |
|---|---|
| `trusted` | `trusted` |
| `unknown`, `untrusted` | `untrusted` |
| `public` | `["public"]` (everyone) |
| `private`, `secret` | the configured readers (`fides.readers`), else the gateway principal's id, else `[]` (nobody) |

Reading goes the other way: any reader list without `"public"` is `private`, and the strictest label on any path wins, since ADTL labels a result as a whole.

The check only reads fides-gateway's code; nothing from it is copied into ADTL.
