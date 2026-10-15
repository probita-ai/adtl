# @adtl/interceptors

> **Experimental.** Built on the draft [SEP-2624 interceptors](https://github.com/modelcontextprotocol/experimental-ext-interceptors) and [trust-annotations](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations) proposals, which are still changing. Not a security guarantee.

An MCP **interceptor server** (SEP-2624 draft) with two interceptors:

| Interceptor | Type | Hook | What it does |
|---|---|---|---|
| `adtl.label` | mutation | `tools/call`, `resources/read`, `prompts/get` · response | Labels the result (`_meta["io.modelcontextprotocol/trust-annotations"]`) and records the label in the session |
| `adtl.policy` | validation | `tools/call` · request | Checks the call against the session's labels and the policy: allow, ask or block |

Most people should use [`@adtl/gateway`](https://www.npmjs.com/package/@adtl/gateway), which starts this server and calls it for you. Use this package directly if you are building your own interceptor invoker.

## Run

```sh
npx -y @adtl/interceptors --config adtl.yaml
```

The server speaks MCP over stdio. It declares `capabilities.extensions["io.modelcontextprotocol/interceptors"]` and answers `interceptors/list` and `interceptor/invoke`. See [`@adtl/gateway`](https://www.npmjs.com/package/@adtl/gateway) for the config format.

## Invocation details

- `config.server` (required): the upstream server id, as named under `servers:` in the config
- `context.sessionId`: the session whose labels are read and updated. Without it, `adtl.policy` blocks (fails closed).
- `ask` and `block` are returned as `valid: false, severity: "error"`, with `info["adtl/decision"]` set to `"ask"` or `"block"`. The draft has no "ask" outcome yet.
- `adtl.label` accepts the response payload as `{ method, params, result }`, or as a bare result together with `config.tool`.

## Library use

```ts
import { AdtlInterceptors, createInterceptorServer, loadConfigFile } from "@adtl/interceptors";

const core = new AdtlInterceptors({ config: await loadConfigFile("adtl.yaml") });
const server = createInterceptorServer(core); // connect to any MCP server transport
```

License: Apache-2.0 · https://github.com/probita-ai/adtl
