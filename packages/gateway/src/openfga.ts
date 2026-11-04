/**
 * Relationship-based authorization with OpenFGA (`gateway.openfga`):
 *
 *   openfga:
 *     url: http://localhost:8080
 *     storeId: "${FGA_STORE_ID}"
 *     modelId: "${FGA_MODEL_ID}"     # optional: pin an authorization model
 *     token: "${FGA_TOKEN}"          # optional: bearer token
 *     relation: can_use              # optional: the default relation
 *     timeoutMs: 2000                # optional
 *     tools:                         # optional: per-resource rules, from the call's arguments
 *       github.add_issue_comment: { relation: can_comment, object: "repo:{owner}/{repo}" }
 *
 * Every call becomes one OpenFGA check:
 *
 *   user      user:<id>, service:<id>, or user:anonymous without an id
 *   relation  the tool's rule, else `relation`
 *   object    the tool's rule, else tool:<server>.<tool>, prompt:<server>.<name> or resource:<uri>
 *
 * Ids are percent-encoded, because OpenFGA ids can't hold `:`, `#`, `@` or
 * spaces; ids too long for OpenFGA are replaced by their SHA-256. A rule's
 * `{argument}` must be a string or number, or the call is denied. Tool lists
 * have no arguments, so tools whose object needs them stay listed and are
 * checked when called. An unreachable server or an error denies the call.
 *
 * Works with Auth0 FGA too, by pointing `url` at its API and passing a token.
 */
import { createHash } from "node:crypto";
import type { AuthorizationDecision, AuthorizationRequest, Authorizer } from "./authorizer.js";
import type { OpenFgaConfig } from "./config.js";

/** OpenFGA's limit on the id part of an object or user. */
const MAX_ID = 254;

function fgaId(value: string): string {
  const id = encodeURIComponent(value);
  return id.length <= MAX_ID ? id : `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

const PLACEHOLDER = /\{([A-Za-z0-9_.-]+)\}/g;

export class OpenFgaAuthorizer implements Authorizer {
  readonly name = "openfga";

  constructor(
    private readonly cfg: OpenFgaConfig,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private user(req: AuthorizationRequest): string {
    const p = req.principal;
    if (p.type === "anonymous" || !p.id) return "user:anonymous";
    return `${p.type === "service" ? "service" : "user"}:${fgaId(p.id)}`;
  }

  /** The object of this call, or a reason it can't be built. "listing" means: decide when called. */
  private object(req: AuthorizationRequest, template?: string): { object: string } | { missing: string } | "listing" {
    if (template !== undefined) {
      if (req.arguments === undefined && template.search(PLACEHOLDER) !== -1) return "listing";
      const colon = template.indexOf(":");
      const type = template.slice(0, colon + 1);
      let missing: string | undefined;
      const id = template.slice(colon + 1).replace(PLACEHOLDER, (_, name: string) => {
        const v = req.arguments?.[name];
        if (typeof v !== "string" && typeof v !== "number") {
          missing ??= name;
          return "";
        }
        return String(v);
      });
      return missing !== undefined ? { missing } : { object: `${type}${fgaId(id)}` };
    }
    if (req.tool !== undefined) return { object: `tool:${fgaId(`${req.server}.${req.tool}`)}` };
    if (req.prompt !== undefined) return { object: `prompt:${fgaId(`${req.server}.${req.prompt}`)}` };
    return { object: `resource:${fgaId(req.resource ?? "")}` };
  }

  async check(req: AuthorizationRequest): Promise<AuthorizationDecision> {
    const rule = req.tool !== undefined ? this.cfg.tools[`${req.server}.${req.tool}`] : undefined;
    const target = this.object(req, rule?.object);
    if (target === "listing") return { allow: true };
    const what = req.tool ?? req.prompt ?? req.resource;
    if ("missing" in target) return { allow: false, reason: `openfga: ${what} has no usable argument "${target.missing}"` };

    const user = this.user(req);
    const relation = rule?.relation ?? this.cfg.relation;
    const res = await this.fetchFn(`${this.cfg.url.replace(/\/+$/, "")}/stores/${encodeURIComponent(this.cfg.storeId)}/check`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}) },
      body: JSON.stringify({
        tuple_key: { user, relation, object: target.object },
        ...(this.cfg.modelId ? { authorization_model_id: this.cfg.modelId } : {}),
      }),
      signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    if (!res.ok) throw new Error(`OpenFGA answered ${res.status}`);
    const body = (await res.json()) as { allowed?: unknown };
    if (body.allowed === true) return { allow: true };
    return { allow: false, reason: `OpenFGA: ${user} has no ${relation} on ${target.object}` };
  }
}
