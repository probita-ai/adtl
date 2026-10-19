import { createHash } from "node:crypto";

/**
 * Canonical JSON in the style of RFC 8785 (JCS): object keys sorted by UTF-16
 * code units, no whitespace, ECMAScript number and string serialization.
 *
 * Used to hash tool-call arguments (so an approval is bound to the exact call)
 * and labels (for the trust-annotations evidenceRef digest).
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Cannot canonicalize a non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v) => (v === undefined ? "null" : canonicalize(v))).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`Cannot canonicalize a value of type ${typeof value}`);
  }
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** `sha256:<hex>` of the canonical form of `value`. */
export function digest(value: unknown): string {
  return `sha256:${sha256Hex(canonicalize(value))}`;
}

/** Hash that binds a decision (e.g. a human approval) to one exact tool call. */
export function callHash(server: string, tool: string, args: unknown): string {
  return digest({ server, tool, arguments: args ?? {} });
}

/** What a SEP-2624 confirmation is bound to: one payload, in one phase, sent to (or received from) one peer. */
export interface CallBinding {
  event: string;
  phase: "request" | "response";
  /** `context.target`; null if the invoker did not set it. */
  target: string | null;
  payload: unknown;
}

/** SEP-2624 call binding hash: `sha256:` + hex SHA-256 of the binding's canonical form. */
export function callBindingHash({ event, phase, target, payload }: CallBinding): string {
  return digest({ event, phase, target: target ?? null, payload: payload ?? null });
}
