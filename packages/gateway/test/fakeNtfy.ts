/**
 * A tiny in-process ntfy server: JSON publish (POST /), plain publish
 * (POST /<topic>) and streaming subscribe (GET /<topic>/json?since=<unix>).
 * Plus a fake phone that presses a button on the latest notification.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface NtfyMessage {
  topic: string;
  time: number;
  message: string;
  title?: string;
  actions?: { action: string; label: string; url: string; method: string; body: string; headers?: Record<string, string> }[];
}

export async function startFakeNtfy(opts: { requireToken?: string } = {}) {
  const messages: NtfyMessage[] = [];
  const subscribers = new Map<string, Set<ServerResponse>>();
  const publish = (m: NtfyMessage) => {
    messages.push(m);
    for (const res of subscribers.get(m.topic) ?? []) res.write(`${JSON.stringify({ event: "message", ...m })}\n`);
  };

  const server = createServer(async (req, res) => {
    if (opts.requireToken && req.headers.authorization !== `Bearer ${opts.requireToken}`) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url!, "http://x");
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let body = "";
    for await (const c of req) body += c;
    const now = Math.floor(Date.now() / 1000);

    if (req.method === "POST" && parts.length === 0) {
      publish({ ...(JSON.parse(body) as Omit<NtfyMessage, "time">), time: now });
      res.writeHead(200).end("{}");
    } else if (req.method === "POST" && parts.length === 1) {
      publish({ topic: parts[0]!, message: body, time: now });
      res.writeHead(200).end("{}");
    } else if (req.method === "GET" && parts.length === 2 && parts[1] === "json") {
      const topic = parts[0]!;
      const since = Number(url.searchParams.get("since") ?? now);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      res.write(`${JSON.stringify({ event: "open", topic })}\n`);
      for (const m of messages) if (m.topic === topic && m.time >= since) res.write(`${JSON.stringify({ event: "message", ...m })}\n`);
      const set = subscribers.get(topic) ?? new Set();
      set.add(res);
      subscribers.set(topic, set);
      req.on("close", () => set.delete(res));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  /** Wait for a notification with buttons on `topic`, then press the button labelled `label`. */
  async function press(topic: string, label: "Allow" | "Deny", opts: { tamper?: (body: string) => string } = {}): Promise<NtfyMessage> {
    const deadline = Date.now() + 5000;
    for (;;) {
      const m = [...messages].reverse().find((x) => x.topic === topic && x.actions?.length);
      if (m) {
        const a = m.actions!.find((x) => x.label === label)!;
        const body = opts.tamper ? opts.tamper(a.body) : a.body;
        const res = await fetch(a.url, { method: a.method, body, headers: a.headers ?? {} });
        if (!res.ok) throw new Error(`button press failed: ${res.status}`);
        return m;
      }
      if (Date.now() > deadline) throw new Error(`no notification with buttons on ${topic}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  return {
    url,
    messages,
    press,
    close: () =>
      new Promise<void>((r) => {
        for (const set of subscribers.values()) for (const res of set) res.end();
        server.close(() => r());
      }),
  };
}
