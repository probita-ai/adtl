// `adtl-gateway playground`: a local web playground for ADTL. It runs the real
// gateway in this process, in front of fake GitHub and fake memory servers,
// and shows every call: the label on its result, the session label, the
// policy decision, the audit log and what actually reached GitHub. "Ask"
// decisions come up in the page with Allow / Deny buttons (a notifier that
// answers like ntfy does).
//
// Listens on 127.0.0.1 only. Everything it writes (ledger, audit log, posted
// comments) goes to a temporary folder that is removed on reset and exit.

import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseConfigText } from "@adtl/interceptors";
import {
  AdtlGateway,
  ApprovalBroker,
  GATEWAY_DECISION_KEY,
  InterceptorInvoker,
  JsonlAuditLog,
  bundledInterceptorsCli,
  connectUpstream,
  loadGatewayConfig,
} from "../dist/index.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const FAKE_GITHUB = join(here, "fake-github.mjs");
const FAKE_MEMORY = join(here, "fake-memory.mjs");
export const DEFAULT_CONFIG = readFileSync(join(here, "playground.yaml"), "utf8");
export const DEFAULT_PORT = 4317;
const TRUST_KEY = "io.modelcontextprotocol/trust-annotations";

/** Answers "ask" decisions from the page, the way the ntfy notifier answers them from a phone. */
class PageNotifier {
  name = "playground";
  pending = new Map();

  listen(request, answer, signal) {
    this.pending.set(request.id, { request, answer });
    return new Promise((resolve) => signal.addEventListener("abort", () => {
      this.pending.delete(request.id);
      resolve();
    }));
  }

  async notify(event) {
    if (event.kind === "pending") {
      const p = this.pending.get(event.request.id);
      if (p) p.tokens = event.tokens;
    }
  }

  answer(id, decision) {
    const p = this.pending.get(id);
    return !!p?.tokens && p.answer(p.tokens[decision], "you, in the playground");
  }

  list() {
    return [...this.pending.values()].filter((p) => p.tokens).map(({ request: r }) => ({
      id: r.id, tool: `${r.server}__${r.tool}`, reason: r.reason, matched: r.matched, sessionLabel: r.sessionLabel,
    }));
  }
}

async function stdio(script, env = {}) {
  const client = new Client({ name: "playground-agent", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [script], env: { ...getDefaultEnvironment(), ...env }, stderr: "ignore" }));
  return client;
}

function readJsonl(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function close(s) {
  if (!s) return;
  await Promise.allSettled(s.closers.map((c) => c.close()));
  rmSync(s.work, { recursive: true, force: true });
}

/** Fresh servers, ledger, audit log and session. Throws without side effects if the config is invalid. */
async function build({ adtl, config }) {
  if (adtl) parseConfigText(config); // a broken adtl.yaml fails here, before anything starts
  const work = mkdtempSync(join(tmpdir(), "adtl-playground-"));
  const posted = join(work, "posted.jsonl");
  const s = { adtl, config, work, posted, audit: join(work, "audit.jsonl"), timeline: [], sessionNo: 1, closers: [], auditSeen: 0 };
  try {
    if (adtl) {
      const path = join(work, "adtl.yaml");
      writeFileSync(
        path,
        config.replace(/^(ledger|gateway):[\s\S]*$/m, "") +
          `\nledger:\n  path: ${JSON.stringify(join(work, "ledger.db"))}\n` +
          `gateway:\n  audit: ${JSON.stringify(s.audit)}\n  upstreams:\n` +
          `    github:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(FAKE_GITHUB)}]\n` +
          `      env: { FAKE_GITHUB_POSTED: ${JSON.stringify(posted)} }\n` +
          `    memory:\n      command: ${JSON.stringify(process.execPath)}\n      args: [${JSON.stringify(FAKE_MEMORY)}]\n`,
      );
      const loaded = await loadGatewayConfig(path);
      const interceptors = await connectUpstream("interceptors", {
        command: process.execPath, args: [bundledInterceptorsCli(), "--config", path], env: {},
      }, work);
      s.closers.push(interceptors);
      s.invoker = new InterceptorInvoker(await InterceptorInvoker.discover(interceptors), loaded.gateway.interceptorTimeoutMs);
      s.upstreams = new Map();
      for (const [id, u] of Object.entries(loaded.gateway.upstreams)) {
        const c = await connectUpstream(id, u, work);
        s.closers.push(c);
        s.upstreams.set(id, c);
      }
      s.notifier = new PageNotifier();
      s.approvals = new ApprovalBroker({ notifiers: [s.notifier], timeoutMs: 120_000 });
      s.auditLog = new JsonlAuditLog(s.audit);
    } else {
      s.upstreams = new Map([
        ["github", await stdio(FAKE_GITHUB, { FAKE_GITHUB_POSTED: posted })],
        ["memory", await stdio(FAKE_MEMORY)],
      ]);
      s.closers.push(...s.upstreams.values());
    }
  } catch (err) {
    await close(s);
    throw err;
  }
  return s;
}

/**
 * Start the playground. Resolves once it is listening, with its URL and a
 * `close()` that stops the server and every child process. Port 0 picks a free port.
 */
export async function startPlayground({ port = DEFAULT_PORT, host = "127.0.0.1", warn = (m) => console.error(`[adtl] ${m}`) } = {}) {
  let state;

  function newSession(bump = true) {
    const s = state;
    if (bump) s.sessionNo++;
    s.sessionId = `session-${s.sessionNo}`;
    s.sessionLabel = undefined;
    if (s.adtl) {
      s.gateway = new AdtlGateway({
        sessionId: s.sessionId, upstreams: s.upstreams, invoker: s.invoker, audit: s.auditLog, approvals: s.approvals,
        logger: { info: () => {}, warn },
      });
    }
    s.timeline.push({ kind: "session", session: s.sessionId });
  }

  /** Start over. If the new setup fails (e.g. a broken adtl.yaml), the old one keeps running. */
  async function reset({ adtl = true, config = state?.config ?? DEFAULT_CONFIG } = {}) {
    const next = await build({ adtl, config });
    const old = state;
    state = next;
    newSession(false);
    await close(old);
  }

  async function tools() {
    const s = state;
    if (s.adtl) return (await s.gateway.listTools()).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    const out = [];
    for (const [id, c] of s.upstreams) {
      for (const t of (await c.listTools()).tools) out.push({ name: `${id}__${t.name}`, description: t.description, inputSchema: t.inputSchema });
    }
    return out;
  }

  async function call(name, args) {
    const s = state;
    const entry = { kind: "call", session: s.sessionId, tool: name, args, pending: true };
    s.timeline.push(entry);
    try {
      let r;
      if (s.adtl) {
        r = await s.gateway.callTool(name, args);
      } else {
        const [id, tool] = name.split("__");
        r = await s.upstreams.get(id).callTool({ name: tool, arguments: args });
      }
      entry.text = r.content?.map((c) => c.text ?? "").join("") ?? "";
      entry.isError = !!r.isError;
      entry.label = r._meta?.[TRUST_KEY];
      entry.decision = r._meta?.[GATEWAY_DECISION_KEY];
    } catch (err) {
      entry.text = err.message;
      entry.isError = true;
    }
    if (s.adtl) {
      const audit = readJsonl(s.audit);
      const mine = audit.slice(s.auditSeen).filter((e) => e.sessionId === s.sessionId).at(-1);
      s.auditSeen = audit.length;
      if (mine) {
        entry.audit = mine;
        if (mine.sessionLabel) s.sessionLabel = mine.sessionLabel;
      }
    }
    entry.pending = false;
    return entry;
  }

  function snapshot() {
    const s = state;
    return {
      adtl: s.adtl,
      config: s.config,
      session: s.sessionId,
      sessionLabel: s.sessionLabel,
      timeline: s.timeline,
      audit: s.adtl ? readJsonl(s.audit) : [],
      posted: readJsonl(s.posted),
      approvals: s.notifier?.list() ?? [],
    };
  }

  const page = () => readFileSync(join(here, "index.html"));

  async function body(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return raw ? JSON.parse(raw) : {};
  }

  // One action at a time, except approvals: an "ask" holds its call open until the page answers.
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  const routes = {
    "GET /": async (_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page()),
    "GET /api/state": async () => snapshot(),
    // Not queued: listing tools must not wait behind a call that is waiting for approval.
    "GET /api/tools": async () => tools(),
    "POST /api/reset": async (req) => {
      const b = await body(req);
      return serial(async () => {
        await reset({ adtl: b.adtl ?? state.adtl, config: b.config ?? (b.defaults ? DEFAULT_CONFIG : state.config) });
        return snapshot();
      });
    },
    "POST /api/session": async () => serial(async () => (newSession(), snapshot())),
    "POST /api/call": async (req) => {
      const b = await body(req);
      return serial(() => call(b.name, b.args ?? {}));
    },
    "POST /api/approve": async (req) => {
      const b = await body(req);
      return { ok: state.notifier?.answer(b.id, b.decision === "allow" ? "allow" : "deny") ?? false };
    },
  };

  await reset();

  const server = createServer(async (req, res) => {
    const route = routes[`${req.method} ${req.url.split("?")[0]}`];
    if (!route) return res.writeHead(404).end("not found");
    try {
      const out = await route(req, res);
      if (!res.headersSent) res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out ?? {}));
    } catch (err) {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: err.message }));
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (err) {
    await close(state);
    if (err.code === "EADDRINUSE") {
      throw new Error(`Port ${port} is in use (another playground running?). Try --port ${port + 1}`);
    }
    throw err;
  }
  const actual = server.address().port;
  return {
    url: `http://localhost:${actual}`,
    port: actual,
    async close() {
      const closed = new Promise((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      await closed;
      await close(state);
    },
  };
}
