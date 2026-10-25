/**
 * Policy evaluation: given what the session has seen and the tool about to be
 * called, decide allow / ask / block.
 *
 * Every matching rule is considered and the most restrictive decision wins
 * (block > ask > allow), so rule order never weakens a policy. If no rule
 * matches, the policy's default applies.
 */
import type { Decision, Egress, Policy, PolicyRule } from "./config.js";
import type { Label } from "./label.js";

export interface PolicyInput {
  /** Accumulated label of everything the session has seen so far. */
  session: Label;
  server: string;
  tool: string;
  egress: Egress;
}

export interface PolicyDecision {
  decision: Decision;
  /** Rules that matched and produced `decision` (empty when the default applied). */
  matched: string[];
  reason: string;
  /**
   * For "ask": the approver roles of each winning rule that names some. A
   * person may answer only if, for every list, they belong to one of its roles.
   */
  approvers?: string[][];
}

const DECISION_RANK: Record<Decision, number> = { allow: 0, ask: 1, block: 2 };

function asArray<T>(v: T | readonly T[] | undefined): readonly T[] | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? (v as readonly T[]) : [v as T];
}

/** `*` matches any run of characters; everything else is literal. Used for `server.tool` patterns. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function ruleMatches(rule: PolicyRule, input: PolicyInput): boolean {
  const w = rule.when;
  const integ = asArray(w["session.integrity"]);
  if (integ && !integ.includes(input.session.integrity)) return false;
  const conf = asArray(w["session.confidentiality"]);
  if (conf && !conf.includes(input.session.confidentiality)) return false;
  const egress = asArray(w["tool.egress"]);
  if (egress && !egress.includes(input.egress)) return false;
  const tools = asArray(w.tool);
  if (tools) {
    const qualified = `${input.server}.${input.tool}`;
    if (!tools.some((t) => globToRegExp(t).test(qualified))) return false;
  }
  return true;
}

export function evaluatePolicy(policy: Policy, input: PolicyInput): PolicyDecision {
  const matching = policy.rules.filter((r) => ruleMatches(r, input));
  if (matching.length === 0) {
    return { decision: policy.default, matched: [], reason: `No rule matched; default is ${policy.default}` };
  }
  let decision: Decision = "allow";
  for (const r of matching) {
    if (DECISION_RANK[r.then] > DECISION_RANK[decision]) decision = r.then;
  }
  const winners = matching.filter((r) => r.then === decision);
  const reason = winners
    .map((r) => r.reason ?? `Rule "${r.name}" requires ${decision}`)
    .join("; ");
  const approvers = decision === "ask" ? winners.flatMap((r) => (r.approvers ? [[...r.approvers]] : [])) : [];
  return { decision, matched: winners.map((r) => r.name), reason, ...(approvers.length ? { approvers } : {}) };
}
