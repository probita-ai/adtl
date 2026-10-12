# ADTL — Agent Data Trust Labels

A personal open-source project exploring trust labels for AI agents. The idea: tag every MCP tool result with where it came from and whether it can be trusted, then check those tags before an agent does something risky (allow, block, or ask a human).

It builds on MCP's draft [`trust-annotations`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations) and [interceptors](https://github.com/modelcontextprotocol/experimental-ext-interceptors) work rather than defining a new format, and draws on ideas from Microsoft's [FIDES gateway](https://github.com/microsoft/fides-gateway) research prototype.

![ADTL sketch](docs/adtl-sketch-v2.png)

> **Status:** early sketch, work in progress. Feedback welcome — open an issue.

## License

Apache-2.0
