/**
 * Gateway configuration: how each upstream server's results are labeled, what
 * kind of egress each tool has, and the policy rules.
 *
 * Example (YAML, parsed by the gateway and validated here):
 *
 *   defaults: { integrity: untrusted, confidentiality: private }
 *   servers:
 *     github:
 *       acceptServerClaims: false
 *       tools:
 *         read_issue:   { integrity: untrusted, confidentiality: public }
 *         get_file:     { integrity: trusted,   confidentiality: private }
 *         post_comment: { egress: public }
 *   policy:
 *     default: allow
 *     rules:
 *       - name: no-exfil-after-untrusted
 *         when: { session.integrity: untrusted, tool.egress: [public, external] }
 *         then: ask
 */
import { z } from "zod";
import { CONFIDENTIALITY_LEVELS, INTEGRITY_LEVELS } from "./label.js";

export const EGRESS_KINDS = ["none", "internal", "external", "public", "unknown"] as const;
export type Egress = (typeof EGRESS_KINDS)[number];

export const DECISIONS = ["allow", "ask", "block"] as const;
export type Decision = (typeof DECISIONS)[number];

const integrity = z.enum(INTEGRITY_LEVELS);
const confidentiality = z.enum(CONFIDENTIALITY_LEVELS);
const egress = z.enum(EGRESS_KINDS);
const oneOrMany = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.array(t).nonempty()]);

export const ToolRuleSchema = z
  .object({
    /** Integrity of this tool's results. */
    integrity: integrity.optional(),
    /** Confidentiality of this tool's results. */
    confidentiality: confidentiality.optional(),
    /** Where this tool can send data when called. */
    egress: egress.optional(),
    /** Write tools: argument (an object the server stores with each record, e.g. `metadata`) to stamp the session label into. */
    labelInto: z.string().min(1).optional(),
    /** Read tools: join labels stamped on the records in the result (stricter only). */
    readLabels: z.boolean().optional(),
  })
  .strict();
export type ToolRule = z.infer<typeof ToolRuleSchema>;

export const ServerConfigSchema = z
  .object({
    /**
     * Accept this server's own trust-annotations claims that *relax* a label
     * (e.g. `untrusted: false`). Claims that make a label stricter are always
     * accepted, from any server.
     */
    acceptServerClaims: z.boolean().default(false),
    /** Rule applied to every tool of this server unless the tool overrides it. */
    defaults: ToolRuleSchema.optional(),
    tools: z.record(ToolRuleSchema).default({}),
  })
  .strict();
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

export const PolicyRuleSchema = z
  .object({
    name: z.string().min(1),
    when: z
      .object({
        "session.integrity": oneOrMany(integrity).optional(),
        "session.confidentiality": oneOrMany(confidentiality).optional(),
        "tool.egress": oneOrMany(egress).optional(),
        /** `server.tool` names; `*` matches any run of characters, e.g. `github.*`. */
        tool: oneOrMany(z.string().min(1)).optional(),
      })
      .strict(),
    then: z.enum(DECISIONS),
    reason: z.string().optional(),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicySchema = z
  .object({
    default: z.enum(DECISIONS).default("allow"),
    rules: z.array(PolicyRuleSchema).default([]),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export const LedgerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** SQLite file. Default: ADTL_LEDGER, or ~/.adtl/ledger.db. Relative paths resolve against the config file. */
    path: z.string().min(1).optional(),
    /** Entries older than this are forgotten. */
    retentionDays: z.number().int().positive().default(90),
  })
  .strict();
export type LedgerConfig = z.infer<typeof LedgerConfigSchema>;

export const AdtlConfigSchema = z
  .object({
    /** Label for results with no matching rule. Restrictive by default. */
    defaults: z
      .object({ integrity, confidentiality })
      .strict()
      .default({ integrity: "untrusted", confidentiality: "private" }),
    servers: z.record(ServerConfigSchema).default({}),
    policy: PolicySchema.default({}),
    /** Label ledger: remembers content written by tainted sessions and re-labels it when it is read back. */
    ledger: LedgerConfigSchema.default({}),
    /** Settings for adtl-gateway (upstream servers, audit log). Validated by the gateway, ignored here. */
    gateway: z.unknown().optional(),
  })
  .strict();
export type AdtlConfig = z.infer<typeof AdtlConfigSchema>;
export type AdtlConfigInput = z.input<typeof AdtlConfigSchema>;

/** Validate and fill defaults. Throws a ZodError describing every problem. */
export function parseConfig(input: unknown): AdtlConfig {
  return AdtlConfigSchema.parse(input ?? {});
}
