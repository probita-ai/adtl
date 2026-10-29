/**
 * Attribute-based authorization with Cedar (`gateway.cedar`):
 *
 *   cedar:
 *     policies: ./adtl.cedar         # Cedar policies, relative to adtl.yaml
 *     entities: ./entities.json      # optional: Cedar entities (groups, attributes)
 *     timeZone: Europe/Berlin        # optional: for context.time (default: the gateway's)
 *
 * Every call becomes a Cedar request:
 *
 *   principal  User::"alice", Service::"ci", or Anonymous::"anonymous" without an id
 *   action     Action::"tools/call", Action::"resources/read" or Action::"prompts/get"
 *   resource   Tool::"github.add_issue_comment", Prompt::"github.triage" or Resource::"<uri>"
 *   context    { server, principalId, listing, time: { hour, minute, weekday }, arguments }
 *
 * Cedar denies unless a policy permits, and a `forbid` wins over any permit.
 * Tool lists are filtered with `listing: true` and no `arguments`, so a policy
 * on arguments should start with `context.listing ||`.
 *
 * Needs the optional dependency @cedar-policy/cedar-wasm, loaded only when
 * `gateway.cedar` is set.
 */
import { readFileSync } from "node:fs";
import type { AuthorizationDecision, AuthorizationRequest, Authorizer } from "./authorizer.js";
import type { CedarConfig } from "./config.js";

type CedarValue = boolean | number | string | CedarValue[] | { [key: string]: CedarValue };

/** The parts of @cedar-policy/cedar-wasm used here. */
interface CedarWasm {
  isAuthorized(call: unknown): CedarAnswer;
  checkParsePolicySet(policies: unknown): { type: "success" } | { type: "failure"; errors: { message: string }[] };
  checkParseEntities(call: unknown): { type: "success" } | { type: "failure"; errors: { message: string }[] };
}
type CedarAnswer =
  | { type: "failure"; errors: { message: string }[] }
  | { type: "success"; response: { decision: "allow" | "deny"; diagnostics: { reason: string[]; errors: { policyId: string; error: { message: string } }[] } } };

export class CedarAuthorizer implements Authorizer {
  readonly name = "cedar";

  private constructor(
    private readonly cedar: CedarWasm,
    private readonly policies: string,
    private readonly entities: unknown[],
    private readonly timeZone: string | undefined,
  ) {}

  /** Load the Cedar engine and the policy files. Throws on a missing package or files that don't parse. */
  static async load(cfg: CedarConfig, resolvePath: (p: string) => string): Promise<CedarAuthorizer> {
    let cedar: CedarWasm;
    try {
      cedar = (await import("@cedar-policy/cedar-wasm/nodejs")) as unknown as CedarWasm;
    } catch {
      throw new Error("gateway.cedar needs the Cedar engine: npm install @cedar-policy/cedar-wasm");
    }
    const policies = readFileSync(resolvePath(cfg.policies), "utf8");
    const parsed = cedar.checkParsePolicySet({ staticPolicies: policies });
    if (parsed.type === "failure") throw new Error(`gateway.cedar.policies: ${parsed.errors.map((e) => e.message).join("; ")}`);

    let entities: unknown[] = [];
    if (cfg.entities) {
      const json: unknown = JSON.parse(readFileSync(resolvePath(cfg.entities), "utf8"));
      if (!Array.isArray(json)) throw new Error("gateway.cedar.entities: expected a JSON array of Cedar entities");
      const ok = cedar.checkParseEntities({ entities: json });
      if (ok.type === "failure") throw new Error(`gateway.cedar.entities: ${ok.errors.map((e) => e.message).join("; ")}`);
      entities = json;
    }
    return new CedarAuthorizer(cedar, policies, entities, cfg.timeZone);
  }

  check(req: AuthorizationRequest): AuthorizationDecision {
    const { principal } = req;
    const [type, id] =
      req.event === "tools/call"
        ? (["Tool", `${req.server}.${req.tool}`] as const)
        : req.event === "prompts/get"
          ? (["Prompt", `${req.server}.${req.prompt}`] as const)
          : (["Resource", req.resource ?? ""] as const);
    const context: Record<string, CedarValue> = {
      server: req.server,
      listing: req.arguments === undefined,
      time: clock(new Date(), this.timeZone),
      ...(principal.id !== undefined ? { principalId: principal.id } : {}),
      ...(req.arguments !== undefined ? { arguments: toCedar(req.arguments) ?? {} } : {}),
    };
    const answer = this.cedar.isAuthorized({
      principal:
        principal.id === undefined
          ? { type: "Anonymous", id: "anonymous" }
          : { type: principal.type === "service" ? "Service" : "User", id: principal.id },
      action: { type: "Action", id: req.event },
      resource: { type, id },
      context,
      policies: { staticPolicies: this.policies },
      entities: this.entities,
    });
    if (answer.type === "failure") throw new Error(answer.errors.map((e) => e.message).join("; "));
    const { decision, diagnostics } = answer.response;
    if (decision === "allow") return { allow: true };
    const who = principal.id ?? "an anonymous caller";
    const what = `the ${type.toLowerCase()} ${id}`;
    return {
      allow: false,
      reason: diagnostics.reason.length
        ? `Cedar policy ${diagnostics.reason.join(", ")} forbids ${who} to use ${what}`
        : `No Cedar policy permits ${who} to use ${what}`,
    };
  }
}

/** Hour, minute and weekday ("Mon") in `timeZone`, for working-hours rules. */
export function clock(now: Date, timeZone: string | undefined): Record<string, CedarValue> {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", hour: "numeric", minute: "numeric", weekday: "short" }).formatToParts(now);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { hour: Number(part("hour")), minute: Number(part("minute")), weekday: part("weekday") };
}

/**
 * Tool arguments as Cedar context values. Cedar has no null or fractions, so
 * nulls are left out and fractions become strings. An object with `__entity`
 * or `__extn` would be read as an entity or extension value, so the agent
 * could name any entity; it is passed as a JSON string instead.
 */
export function toCedar(v: unknown): CedarValue | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : String(v);
  if (Array.isArray(v)) return v.map(toCedar).filter((x): x is CedarValue => x !== undefined);
  if (typeof v === "object") {
    if ("__entity" in v || "__extn" in v) return JSON.stringify(v);
    const out: Record<string, CedarValue> = {};
    for (const [k, x] of Object.entries(v)) {
      const c = toCedar(x);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  return String(v);
}
