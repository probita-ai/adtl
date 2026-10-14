/**
 * Email notices over SMTP. Notify only, on purpose: emails never contain
 * approve links, because mail security scanners open links automatically and
 * would approve calls by themselves. Approving happens on the push channel.
 *
 * Emails name the tool, server and reason, never arguments or results.
 */
import nodemailer from "nodemailer";
import type { ApprovalEvent, Notifier } from "./approvals.js";

export const EMAIL_EVENTS = ["pending", "blocked", "approved", "denied", "timeout", "undeliverable"] as const;
export type EmailEvent = (typeof EMAIL_EVENTS)[number];

export interface MailSender {
  sendMail(mail: { from: string; to: string[]; subject: string; text: string }): Promise<unknown>;
}

export interface EmailOptions {
  from: string;
  to: string[];
  /** Which events send an email. */
  on: EmailEvent[];
  /** SMTP settings, used unless `sender` is given. */
  smtp?: { host: string; port: number; secure?: boolean; user?: string; pass?: string };
  sender?: MailSender;
}

export class EmailNotifier implements Notifier {
  readonly name = "email";
  private readonly sender: MailSender;

  constructor(private readonly opts: EmailOptions) {
    if (opts.sender) {
      this.sender = opts.sender;
    } else if (opts.smtp) {
      const { host, port, secure, user, pass } = opts.smtp;
      this.sender = nodemailer.createTransport({
        host,
        port,
        secure: secure ?? port === 465,
        ...(user !== undefined ? { auth: { user, pass } } : {}),
      });
    } else {
      throw new Error("EmailNotifier needs smtp settings or a sender");
    }
  }

  async notify(event: ApprovalEvent): Promise<void> {
    const kind: EmailEvent = event.kind === "resolved" ? event.result.outcome : event.kind;
    if (!this.opts.on.includes(kind)) return;
    const { subject, text } = this.compose(event);
    await this.sender.sendMail({ from: this.opts.from, to: this.opts.to, subject, text });
  }

  private compose(event: ApprovalEvent): { subject: string; text: string } {
    const footer = "\n\n-- \nSent by ADTL (adtl-gateway). This email never contains approve links; approve on your push channel.";
    if (event.kind === "blocked") {
      return {
        subject: `ADTL blocked ${event.server}.${event.tool}`,
        text: `ADTL blocked a call to ${event.server}.${event.tool}.\n\nReason: ${event.reason}\nRule: ${event.matched.join(", ") || "default"}\nSession: ${event.sessionId}${footer}`,
      };
    }
    const r = event.request;
    const subject = `${r.server}.${r.tool}`;
    if (event.kind === "pending") {
      return {
        subject: `ADTL: approval needed for ${subject}`,
        text:
          `An agent wants to call ${subject} and ADTL needs your approval.\n\nReason: ${r.reason}\nRule: ${r.matched.join(", ") || "default"}\n` +
          `Session: ${r.sessionId}\nExpires: ${r.expiresAt.toISOString()} (no answer means deny)${footer}`,
      };
    }
    const res = event.result;
    return {
      subject: `ADTL: ${subject} ${res.outcome}`,
      text: `The approval request for ${subject} was ${res.outcome}${res.channel ? ` via ${res.channel}` : ""} after ${Math.round(res.waitedMs / 1000)}s.\n\nReason it was asked: ${r.reason}\nSession: ${r.sessionId}${footer}`,
    };
  }
}
