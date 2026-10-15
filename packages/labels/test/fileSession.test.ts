import { describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileSessionStore, defaultSessionsDir, type Label } from "../src/index.js";

const untrusted: Label = { integrity: "untrusted", confidentiality: "public", origins: [{ server: "claude-code", tool: "WebFetch" }] };
const secret: Label = { integrity: "trusted", confidentiality: "secret", origins: [{ server: "github", tool: "get_file" }] };

function tempStore(): FileSessionStore {
  return new FileSessionStore(join(mkdtempSync(join(tmpdir(), "adtl-sessions-")), "sessions"));
}

describe("FileSessionStore", () => {
  it("starts empty and only gets stricter", () => {
    const s = tempStore();
    expect(s.get("a")).toMatchObject({ integrity: "trusted", confidentiality: "public", origins: [] });
    expect(s.observe("a", untrusted)).toMatchObject({ integrity: "untrusted", confidentiality: "public" });
    expect(s.observe("a", secret)).toMatchObject({ integrity: "untrusted", confidentiality: "secret" });
    expect(s.get("a").origins).toHaveLength(2);
    expect(s.get("b").integrity).toBe("trusted");
  });

  it("shares state between store instances, as separate processes would", () => {
    const one = tempStore();
    const two = new FileSessionStore(one.dir);
    one.observe("s", untrusted);
    two.observe("s", secret);
    expect(one.get("s")).toMatchObject({ integrity: "untrusted", confidentiality: "secret" });
  });

  it("resets by deleting the session file", () => {
    const s = tempStore();
    s.observe("s", untrusted);
    s.reset("s");
    s.reset("s");
    expect(s.get("s").integrity).toBe("trusted");
  });

  it("treats a damaged line as untrusted and private", () => {
    const s = tempStore();
    appendFileSync(s.pathOf("s"), "{not json\n");
    expect(s.get("s")).toMatchObject({ integrity: "untrusted", confidentiality: "private" });
  });

  it("keeps odd session ids inside its directory", () => {
    const s = tempStore();
    const p = s.pathOf("../../etc/passwd");
    expect(dirname(p)).toBe(s.dir);
    s.observe("../../etc/passwd", untrusted);
    expect(readdirSync(s.dir)).toHaveLength(1);
  });

  it("writes files only the owner can read", () => {
    const s = tempStore();
    s.observe("s", untrusted);
    expect(statSync(s.pathOf("s")).mode & 0o077).toBe(0);
  });

  it("defaults to ADTL_SESSIONS_DIR or ~/.adtl/sessions", () => {
    expect(defaultSessionsDir({ ADTL_SESSIONS_DIR: "/x/y" })).toBe("/x/y");
    expect(defaultSessionsDir({})).toMatch(/\.adtl[\\/]sessions$/);
  });
});
