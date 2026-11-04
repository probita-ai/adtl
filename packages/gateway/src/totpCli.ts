/**
 * `adtl-gateway totp`: set up authenticator-app approvals.
 *
 *   adtl-gateway totp setup [--force]
 *   adtl-gateway totp check <code>
 */
import { userInfo } from "node:os";
import qrcode from "qrcode-terminal";
import { base32Decode, newTotpSecret, totpCode, totpSecretStore, totpStep, totpUri, type TotpSecretStore } from "./totp.js";

export const TOTP_USAGE = `Usage: adtl-gateway totp setup [--force]
       adtl-gateway totp check <code>

setup makes a secret, stores it, and shows a QR code to scan into an
authenticator app. --force replaces an existing secret. check tells you
whether a code matches right now, without using it up. Then set
gateway.approvals.totp: true.`;

export interface TotpCommandResult {
  stdout: string;
  exitCode: number;
}

function qr(text: string): Promise<string> {
  return new Promise((resolve) => qrcode.generate(text, { small: true }, resolve));
}

export async function runTotpCommand(argv: string[], opts: { store?: TotpSecretStore; now?: () => number } = {}): Promise<TotpCommandResult> {
  const store = opts.store ?? totpSecretStore();
  const [cmd, ...rest] = argv;
  if (cmd === "setup" && rest.every((a) => a === "--force")) {
    if (store.read() && !rest.includes("--force")) {
      return { stdout: `A secret is already stored in ${store.where}. Use --force to replace it; codes from the old one stop working.`, exitCode: 1 };
    }
    const secret = newTotpSecret();
    store.write(secret);
    const uri = totpUri(secret, userInfo().username);
    return {
      stdout: `${await qr(uri)}\nScan this with your authenticator app, or enter the key by hand:\n\n  ${secret}\n\nStored in ${store.where}. Clear your terminal afterwards: this screen shows the secret.\nThen set gateway.approvals.totp: true, and test a code with: adtl-gateway totp check <code>`,
      exitCode: 0,
    };
  }
  if (cmd === "check" && rest.length === 1) {
    const secret = store.read();
    if (!secret) return { stdout: "No secret yet: run adtl-gateway totp setup", exitCode: 1 };
    const key = base32Decode(secret);
    const step = totpStep((opts.now ?? Date.now)());
    const ok = [step - 1, step, step + 1].some((s) => totpCode(key, s) === rest[0]);
    return { stdout: ok ? "The code matches." : "The code doesn't match. Check the time on your phone.", exitCode: ok ? 0 : 1 };
  }
  return { stdout: TOTP_USAGE, exitCode: cmd === undefined || cmd === "--help" || cmd === "-h" ? 0 : 1 };
}
