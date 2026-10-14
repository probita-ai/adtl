/**
 * ntfy (https://ntfy.sh) push notifications with Allow / Deny buttons.
 *
 * The buttons make the phone POST a signed answer token to a reply topic on
 * the same ntfy server, and the gateway subscribes to that topic. So answers
 * reach the gateway without it ever accepting inbound connections.
 *
 * Messages name the tool, server and reason, never arguments or results.
 * Anyone who can read the topic can press the buttons, so use a long random
 * topic name or an access-controlled topic on your own server.
 */
import type { AnswerFn, ApprovalEvent, ApprovalRequest, Notifier } from "./approvals.js";

export interface NtfyOptions {
  /** Server base URL, e.g. https://ntfy.sh */
  server: string;
  topic: string;
  /** Topic answers are posted to. Default: `<topic>-reply`. */
  replyTopic?: string;
  /** Access token for protected topics. */
  token?: string;
  fetch?: typeof fetch;
  /** Delay before re-subscribing after the stream drops, and the base delay between publish retries. */
  reconnectMs?: number;
  /** Publish attempts before giving up (network errors, 429 and 5xx are retried). */
  publishAttempts?: number;
}

function describe(request: ApprovalRequest): string {
  const secs = Math.max(0, Math.round((request.expiresAt.getTime() - request.createdAt.getTime()) / 1000));
  return `${request.reason}\n\nRule: ${request.matched.join(", ") || "default"}\nExpires in ${secs}s; no answer means deny.`;
}

export class NtfyNotifier implements Notifier {
  readonly name = "ntfy";
  private readonly server: string;
  private readonly topic: string;
  private readonly replyTopic: string;
  private readonly token: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly reconnectMs: number;
  private readonly publishAttempts: number;

  constructor(opts: NtfyOptions) {
    this.server = opts.server.replace(/\/+$/, "");
    this.topic = opts.topic;
    this.replyTopic = opts.replyTopic ?? `${opts.topic}-reply`;
    this.token = opts.token;
    this.fetch = opts.fetch ?? globalThis.fetch;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    this.publishAttempts = opts.publishAttempts ?? 3;
  }

  private get auth(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async notify(event: ApprovalEvent): Promise<void> {
    if (event.kind === "blocked") return; // push is for decisions; email covers blocked notices
    const { request } = event;
    const subject = `${request.server}.${request.tool}`;
    let message: Record<string, unknown>;
    if (event.kind === "pending") {
      const reply = `${this.server}/${encodeURIComponent(this.replyTopic)}`;
      const button = (label: string, body: string) => ({
        action: "http",
        label,
        url: reply,
        method: "POST",
        body,
        clear: true,
        ...(this.token ? { headers: this.auth } : {}),
      });
      message = {
        title: `ADTL: allow ${subject}?`,
        message: describe(request),
        priority: 4,
        tags: ["warning"],
        actions: [button("Allow", event.tokens.allow), button("Deny", event.tokens.deny)],
      };
    } else {
      message = {
        title: `ADTL: ${subject} ${event.result.outcome}`,
        message: `Approval ${event.result.outcome} after ${Math.round(event.result.waitedMs / 1000)}s.`,
        priority: 2,
        tags: [event.result.outcome === "approved" ? "white_check_mark" : "x"],
      };
    }
    await this.publish(JSON.stringify({ topic: this.topic, ...message }));
  }

  /** POST with retries: flaky networks should not turn an approval request into a denial. */
  private async publish(body: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.fetch(this.server, { method: "POST", headers: { "Content-Type": "application/json", ...this.auth }, body });
      } catch (err) {
        if (attempt >= this.publishAttempts) throw err;
      }
      if (res?.ok) return;
      if (res && ((res.status !== 429 && res.status < 500) || attempt >= this.publishAttempts)) {
        throw new Error(`ntfy publish failed: HTTP ${res.status}`);
      }
      await new Promise((r) => setTimeout(r, this.reconnectMs * attempt));
    }
  }

  async listen(request: ApprovalRequest, answer: AnswerFn, signal: AbortSignal): Promise<void> {
    // `since` replays anything posted after the request was created, so a fast
    // answer is not lost while (re)connecting.
    const since = Math.floor(request.createdAt.getTime() / 1000) - 1;
    const url = `${this.server}/${encodeURIComponent(this.replyTopic)}/json?since=${since}`;
    while (!signal.aborted) {
      try {
        const res = await this.fetch(url, { headers: this.auth, signal });
        if (!res.ok || !res.body) throw new Error(`ntfy subscribe failed: HTTP ${res.status}`);
        await this.read(res.body, answer, signal);
      } catch (err) {
        if (signal.aborted) return;
        if ((err as Error).message.includes("HTTP 401") || (err as Error).message.includes("HTTP 403")) throw err;
      }
      if (!signal.aborted) await sleep(this.reconnectMs, signal);
    }
  }

  private async read(body: ReadableStream<Uint8Array>, answer: AnswerFn, signal: AbortSignal): Promise<void> {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      if (signal.aborted) return;
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as { event?: string; message?: string };
          if (msg.event === "message" && typeof msg.message === "string") answer(msg.message);
        } catch {
          // Not JSON: ignore.
        }
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
