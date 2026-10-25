/**
 * `adtl-gateway playground [--port 4317] [--no-open]`: the web playground, with
 * the real gateway in front of fake GitHub and memory servers. Listens on
 * 127.0.0.1 only and opens the browser unless --no-open is given.
 */
import { spawn } from "node:child_process";

export const PLAYGROUND_USAGE = `Usage: adtl-gateway playground [--port <n>] [--no-open]

Runs the ADTL gateway in front of fake GitHub and memory servers, with a
browser UI: three test cases, every call's label and decision, the session
label, approvals, the config and the audit log. Nothing leaves your machine.

  --port <n>   Port on 127.0.0.1 (default 4317; 0 picks a free one).
  --no-open    Don't open the browser.`;

interface Playground {
  url: string;
  close(): Promise<void>;
}

export function parsePlaygroundArgs(argv: string[]): { port: number; open: boolean; help: boolean } {
  let port = 4317;
  let open = true;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--port") port = Number(argv[++i]);
    else if (a === "--no-open") open = false;
    else if (a === "-h" || a === "--help") help = true;
    else throw new Error(`Unknown argument: ${a}\n\n${PLAYGROUND_USAGE}`);
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be a number from 0 to 65535\n\n${PLAYGROUND_USAGE}`);
  return { port, open, help };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // No browser to open: the URL is printed anyway.
  }
}

export async function runPlayground(argv: string[]): Promise<void> {
  const opts = parsePlaygroundArgs(argv);
  if (opts.help) return void console.log(PLAYGROUND_USAGE);
  // Plain JavaScript shipped next to dist/, not compiled.
  const mod = (await import(new URL("../playground/server.mjs", import.meta.url).href)) as {
    startPlayground(o: { port: number }): Promise<Playground>;
  };
  const pg = await mod.startPlayground({ port: opts.port });
  console.log(`ADTL playground: ${pg.url}  (Ctrl-C to stop)`);
  if (opts.open) openBrowser(pg.url);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => void pg.close().finally(() => process.exit(0)));
  }
}
