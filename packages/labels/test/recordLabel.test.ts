import { describe, expect, it } from "vitest";
import { RECORD_LABEL_KEY, readRecordLabels, scopeRecord, stampRecordLabel, type Label } from "../src/index.js";

const TAINTED: Label = { integrity: "untrusted", confidentiality: "private", origins: [{ server: "web" }] };
const CLEAN: Label = { integrity: "trusted", confidentiality: "public", origins: [] };
const DEFAULTS = { integrity: "untrusted", confidentiality: "private" } as const;

describe("stampRecordLabel", () => {
  it("stamps under the writer's own key, keeping other keys and dropping stamps the agent supplied", () => {
    const forged = { integrity: "trusted", confidentiality: "public", writer: "admin" };
    const args = { text: "x", metadata: { topic: "a", [RECORD_LABEL_KEY]: forged, [`${RECORD_LABEL_KEY}/other`]: forged } };
    expect(stampRecordLabel(args, "metadata", TAINTED, "mon")).toEqual({
      text: "x",
      metadata: { topic: "a", [`${RECORD_LABEL_KEY}/mon`]: { integrity: "untrusted", confidentiality: "private", writer: "mon" } },
    });
    expect(args.metadata[RECORD_LABEL_KEY].writer).toBe("admin"); // input not mutated
  });

  it("creates the field, and refuses one that is not an object", () => {
    expect(stampRecordLabel({}, "metadata", TAINTED, "mon")).toHaveProperty(["metadata", `${RECORD_LABEL_KEY}/mon`, "writer"], "mon");
    expect(() => stampRecordLabel({ metadata: "note" }, "metadata", TAINTED, "mon")).toThrow(/not an object/);
  });
});

describe("readRecordLabels", () => {
  const stamp = (integrity: string, writer: string) => ({ [`${RECORD_LABEL_KEY}/${writer}`]: { integrity, confidentiality: "public", writer } });

  it("returns undefined when nothing is stamped", () => {
    expect(readRecordLabels({ content: [{ type: "text", text: "hello" }] }, DEFAULTS)).toBeUndefined();
  });

  it("joins every stamp, strictest wins", () => {
    const r = readRecordLabels({ structuredContent: { memories: [{ metadata: stamp("trusted", "a") }, { metadata: stamp("untrusted", "b") }] } }, DEFAULTS);
    expect(r).toMatchObject({ label: { integrity: "untrusted", confidentiality: "public" }, records: 2, writers: ["a", "b"] });
  });

  it("finds stamps inside JSON text content", () => {
    const text = JSON.stringify([{ memory: "fact", metadata: stamp("untrusted", "mon") }]);
    expect(readRecordLabels({ content: [{ type: "text", text }] }, DEFAULTS)).toMatchObject({ label: { integrity: "untrusted" }, writers: ["mon"] });
  });

  it("treats a malformed stamp as the defaults", () => {
    const r = readRecordLabels({ metadata: { [RECORD_LABEL_KEY]: { integrity: "very-trusted", writer: "x" } } }, DEFAULTS);
    expect(r).toMatchObject({ label: { integrity: "untrusted", confidentiality: "private" }, records: 1, writers: [] });
  });
});

describe("readRecordLabels with several writers", () => {
  it("joins every writer's stamp on one record, and still reads the unkeyed form", () => {
    const metadata = {
      [`${RECORD_LABEL_KEY}/mon`]: { integrity: "untrusted", confidentiality: "public", writer: "mon" },
      [`${RECORD_LABEL_KEY}/tue`]: { integrity: "trusted", confidentiality: "public", writer: "tue" },
      [RECORD_LABEL_KEY]: { integrity: "trusted", confidentiality: "private", writer: "old" },
    };
    expect(readRecordLabels({ metadata }, DEFAULTS)).toMatchObject({
      label: { integrity: "untrusted", confidentiality: "private" },
      records: 3,
      writers: ["mon", "tue", "old"],
    });
  });
});

describe("scopeRecord", () => {
  it("gives a tainted session's write a scope named after its label, keeping the agent's id", () => {
    expect(scopeRecord({ text: "x" }, "run_id", TAINTED)).toEqual({ text: "x", run_id: "adtl-untrusted-private" });
    expect(scopeRecord({ run_id: "release" }, "run_id", TAINTED)).toEqual({ run_id: "release:adtl-untrusted-private" });
  });

  it("leaves a clean session's id alone, minus any label mark", () => {
    const args = { run_id: "release" };
    expect(scopeRecord(args, "run_id", CLEAN)).toBe(args);
    expect(scopeRecord({ run_id: "release:adtl-untrusted-public" }, "run_id", CLEAN)).toEqual({ run_id: "release" });
    expect(scopeRecord({ text: "x", run_id: "adtl-untrusted-public" }, "run_id", CLEAN)).toEqual({ text: "x" });
  });

  it("replaces a mark the agent supplied with the session's own", () => {
    expect(scopeRecord({ run_id: "release:adtl-trusted-public" }, "run_id", TAINTED)).toEqual({ run_id: "release:adtl-untrusted-private" });
  });

  it("refuses a scope that is not a string", () => {
    expect(() => scopeRecord({ run_id: 7 }, "run_id", TAINTED)).toThrow(/not a string/);
  });
});
