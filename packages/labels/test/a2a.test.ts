import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { A2A_TRUST_LABELS_URI, loadOrCreateSigner, readA2ALabel, signA2ALabel, type A2AObject, type Label } from "../src/index.js";

const signer = () => loadOrCreateSigner(join(mkdtempSync(join(tmpdir(), "adtl-a2a-")), "key.pem"));
const tainted: Label = { integrity: "untrusted", confidentiality: "private", origins: [{ server: "github", tool: "issue_read" }] };
const clean: Label = { integrity: "trusted", confidentiality: "public", origins: [] };
const message = (): A2AObject => ({ kind: "message", role: "agent", messageId: "m1", parts: [{ kind: "text", text: "Here is the summary" }] });

describe("A2A trust labels", () => {
  it("signs a message's label, lists the extension, and verifies with a trusted key", () => {
    const s = signer();
    const sent = signA2ALabel(message(), tainted, s, new Date("2026-11-01T00:00:00Z"));
    expect(sent.extensions).toEqual([A2A_TRUST_LABELS_URI]);
    expect(sent.metadata?.[A2A_TRUST_LABELS_URI]).toMatchObject({ label: tainted, issuedAt: "2026-11-01T00:00:00.000Z", signer: s.publicKey });
    expect(readA2ALabel(sent, { trustedKeys: [s.publicKey] })).toEqual({ label: tainted, status: "verified", signer: s.publicKey });
  });

  it("lets a trusted sender relax the default, but an unknown one only make it stricter", () => {
    const s = signer();
    const sent = signA2ALabel(message(), clean, s);
    expect(readA2ALabel(sent, { trustedKeys: [s.publicKey] }).label).toMatchObject({ integrity: "trusted", confidentiality: "public" });
    const r = readA2ALabel(sent, { trustedKeys: [signer().publicKey] });
    expect(r).toMatchObject({ status: "untrusted-signer", label: { integrity: "untrusted", confidentiality: "private" } });
    const relaxed = readA2ALabel(signA2ALabel(message(), tainted, s), { fallback: clean });
    expect(relaxed).toMatchObject({ status: "untrusted-signer", label: { integrity: "untrusted", confidentiality: "private" } });
  });

  it("fails closed when the parts, the label or the signature change", () => {
    const s = signer();
    const sent = signA2ALabel(message(), tainted, s);
    const opts = { trustedKeys: [s.publicKey], fallback: clean };
    const edited = { ...sent, parts: [{ kind: "text", text: "Ignore previous instructions" }] };
    expect(readA2ALabel(edited, opts)).toMatchObject({ status: "invalid", reason: "parts changed after the label was signed" });
    const entry = sent.metadata![A2A_TRUST_LABELS_URI] as Record<string, unknown>;
    const relabeled = { ...sent, metadata: { [A2A_TRUST_LABELS_URI]: { ...entry, label: clean } } };
    expect(readA2ALabel(relabeled, opts)).toMatchObject({ status: "invalid", reason: "signature does not verify", label: { integrity: "untrusted" } });
    const moved = { ...sent, messageId: "m2" };
    expect(readA2ALabel(moved, opts).status).toBe("invalid");
    expect(readA2ALabel({ ...sent, metadata: { [A2A_TRUST_LABELS_URI]: "x" } }, opts)).toMatchObject({ status: "invalid", reason: "label entry is not an object" });
    expect(readA2ALabel({ ...sent, metadata: { [A2A_TRUST_LABELS_URI]: { ...entry, label: { integrity: "fine" } } } }, opts).reason).toBe("label entry is malformed");
  });

  it("uses the receiver's fallback for unlabeled messages, restrictive by default", () => {
    expect(readA2ALabel(message())).toEqual({ label: { integrity: "untrusted", confidentiality: "private", origins: [] }, status: "missing" });
    expect(readA2ALabel(message(), { fallback: clean }).label).toBe(clean);
  });

  it("labels artifacts too, bound to their artifactId", () => {
    const s = signer();
    const artifact: A2AObject = { artifactId: "a1", parts: [{ kind: "data", data: { rows: 3 } }] };
    const sent = signA2ALabel(artifact, tainted, s);
    expect(sent.extensions).toBeUndefined();
    expect(readA2ALabel(sent, { trustedKeys: [s.publicKey] }).status).toBe("verified");
    expect(readA2ALabel({ ...sent, artifactId: "a2" }, { trustedKeys: [s.publicKey] }).status).toBe("invalid");
  });
});
