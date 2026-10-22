/**
 * Role-based authorization from the config (`gateway.roles`):
 *
 *   roles:
 *     maintainers: { members: [alice, bob], tools: ["github.*"] }
 *     readers:     { members: ["*"],        tools: ["github.read_*", "github.get_*"] }
 *
 * A call is allowed if a role the caller belongs to grants it: `tools` and
 * `prompts` are `server.name` patterns (the same `*` wildcards as policy
 * rules), `resources` are URI patterns. Everything else is denied. Members
 * are principal ids; "*" means everyone, including an anonymous caller.
 */
import { globToRegExp } from "@adtl/labels";
import type { AuthorizationDecision, AuthorizationRequest, Authorizer } from "./authorizer.js";
import type { RoleConfig } from "./config.js";

interface CompiledRole {
  name: string;
  members: Set<string>;
  tools: RegExp[];
  prompts: RegExp[];
  resources: RegExp[];
}

export class RoleAuthorizer implements Authorizer {
  readonly name = "roles";
  private readonly roles: CompiledRole[];

  constructor(roles: Record<string, RoleConfig>) {
    this.roles = Object.entries(roles).map(([name, r]) => ({
      name,
      members: new Set(r.members),
      tools: r.tools.map(globToRegExp),
      prompts: r.prompts.map(globToRegExp),
      resources: r.resources.map(globToRegExp),
    }));
  }

  check(req: AuthorizationRequest): AuthorizationDecision {
    const id = req.principal.id;
    const [kind, what] =
      req.event === "tools/call"
        ? (["tools", `${req.server}.${req.tool}`] as const)
        : req.event === "prompts/get"
          ? (["prompts", `${req.server}.${req.prompt}`] as const)
          : (["resources", req.resource ?? ""] as const);
    const granted = this.roles.some(
      (r) => (r.members.has("*") || (id !== undefined && r.members.has(id))) && r[kind].some((p) => p.test(what)),
    );
    if (granted) return { allow: true };
    const who = id ?? "an anonymous caller";
    const noun = kind === "tools" ? "tool" : kind === "prompts" ? "prompt" : "resource";
    return { allow: false, reason: `No role lets ${who} use the ${noun} ${what}` };
  }
}
