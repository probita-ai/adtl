/**
 * Authorization: may this caller use this tool, resource or prompt at all?
 *
 * Labels and the policy answer "may this call run, given what the session has
 * seen?". An Authorizer answers the question before it, from who is calling.
 * The gateway asks it on every tools/call, resources/read and prompts/get,
 * before the request interceptors run, and the stricter answer wins: a denial
 * stops the call whatever the policy would say, and an allow still leaves the
 * call to the policy.
 *
 * The caller is the SEP-2624 `context.principal` the gateway passes to the
 * interceptors. Over stdio that is whoever started the gateway (anonymous
 * unless configured); authenticated transports can fill it in per request.
 *
 * An authorizer that throws denies the call (fails closed). In audit mode
 * denials are logged and not enforced, like policy decisions.
 */
import type { InvocationContext } from "@adtl/interceptors";

export type Principal = NonNullable<InvocationContext["principal"]>;

export interface AuthorizationRequest {
  principal: Principal;
  event: "tools/call" | "resources/read" | "prompts/get";
  /** Upstream server id, as named in the config. */
  server: string;
  /** Exactly one of tool, resource or prompt is set, matching `event`. */
  tool?: string;
  resource?: string;
  prompt?: string;
  /** Tool or prompt arguments, for authorizers that decide on them. */
  arguments?: Record<string, unknown>;
}

export type AuthorizationDecision = { allow: true } | { allow: false; reason: string };

export interface Authorizer {
  /** Shown in audit entries and error messages, e.g. "rbac". */
  readonly name: string;
  check(request: AuthorizationRequest): AuthorizationDecision | Promise<AuthorizationDecision>;
}

/** A denial: which authorizer said no, and why. */
export interface Denial {
  by: string;
  reason: string;
}

/** Ask `authorizer`, failing closed. Returns the denial, or undefined if allowed. */
export async function authorize(authorizer: Authorizer, request: AuthorizationRequest): Promise<Denial | undefined> {
  let d: AuthorizationDecision;
  try {
    d = await authorizer.check(request);
  } catch (err) {
    return { by: authorizer.name, reason: `${authorizer.name} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (d?.allow === true) return undefined;
  const reason = d && "reason" in d && typeof d.reason === "string" && d.reason ? d.reason : `${authorizer.name} denied the call`;
  return { by: authorizer.name, reason };
}
