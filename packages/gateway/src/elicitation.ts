/**
 * Approvals inside the MCP client, through `elicitation/create`: the person
 * using the client (for example Claude Code) sees the request and answers
 * Allow or Deny there, no phone needed.
 *
 * The answer is turned into the same signed token a push button would send,
 * so it answers only the one pending call it was asked about. Declining or
 * dismissing the prompt counts as Deny. The gateway uses this channel only
 * when `gateway.approvals.elicitation` is on and the client declares the
 * elicitation capability, and never for rules with named approvers: the
 * client can't say who answered.
 *
 * With `gateway.approvals.totp`, the prompt asks for a code from the person's
 * authenticator app instead of Allow or Deny, so a client that accepts
 * prompts by itself can't approve anything. Three wrong codes count as Deny.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AnswerFn, ApprovalEvent, ApprovalRequest, Notifier } from "./approvals.js";
import type { TotpVerifier } from "./totp.js";

interface Listening {
  answer: AnswerFn;
  signal: AbortSignal;
}

/** True if the connected client can answer elicitation requests. */
export function supportsElicitation(server: Server): boolean {
  return server.getClientCapabilities()?.elicitation !== undefined;
}

function message(request: ApprovalRequest): string {
  const rule = request.matched.join(", ") || "default";
  return `ADTL: allow ${request.server}.${request.tool}?\n\n${request.reason}\n\nRule: ${rule}. Allow runs this one call; Deny or no answer stops it.`;
}

function codeMessage(request: ApprovalRequest, wrong: number): string {
  const rule = request.matched.join(", ") || "default";
  const again = wrong > 0 ? "That code was not right. " : "";
  return `ADTL: allow ${request.server}.${request.tool}?\n\n${request.reason}\n\nRule: ${rule}. ${again}Enter the code from your authenticator app to run this one call; decline or no answer stops it.`;
}

const MAX_CODE_ATTEMPTS = 3;

export class ElicitationChannel implements Notifier {
  readonly name = "elicitation";
  private readonly listening = new Map<string, Listening>();

  constructor(
    private readonly server: Server,
    private readonly totp?: TotpVerifier,
  ) {}

  async listen(request: ApprovalRequest, answer: AnswerFn, signal: AbortSignal): Promise<void> {
    this.listening.set(request.id, { answer, signal });
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    this.listening.delete(request.id);
  }

  async notify(event: ApprovalEvent): Promise<void> {
    if (event.kind !== "pending") return; // the client sees the call's result; no other notices
    const l = this.listening.get(event.request.id);
    if (!l) throw new Error("not listening for this request");
    // A plain request, not Server.elicitInput(): clients that declare only `elicitation: {}` support forms too.
    const ask = (text: string, properties: Record<string, unknown>, required: string) =>
      this.server.request(
        { method: "elicitation/create", params: { message: text, requestedSchema: { type: "object", properties, required: [required] } } } as never,
        ElicitResultSchema,
        { signal: l.signal, timeout: Math.max(1, event.request.expiresAt.getTime() - Date.now()) },
      );
    if (this.totp) {
      for (let wrong = 0; wrong < MAX_CODE_ATTEMPTS; wrong++) {
        const r = await ask(codeMessage(event.request, wrong), { code: { type: "string", title: "Code", description: "6 digits from your authenticator app" } }, "code");
        if (r.action !== "accept") break;
        if (this.totp.verify(String(r.content?.code ?? ""))) return void l.answer(event.tokens.allow);
      }
      return void l.answer(event.tokens.deny);
    }
    const result = await ask(
      message(event.request),
      { decision: { type: "string", title: "Decision", enum: ["allow", "deny"], description: "allow runs this one call; deny stops it" } },
      "decision",
    );
    const allow = result.action === "accept" && result.content?.decision === "allow";
    l.answer(allow ? event.tokens.allow : event.tokens.deny);
  }
}
