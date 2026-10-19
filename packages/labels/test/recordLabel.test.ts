import { describe, expect, it } from "vitest";
import { RECORD_LABEL_KEY, readRecordLabels, stampRecordLabel, type Label } from "../src/index.js";

const TAINTED: Label = { integrity: "untrusted", confidentiality: "private", origins: [{ server: "web" }] };
const DEFAULTS = { integrity: "untrusted", confidentiality: "private" } as const;

describe("stampRecordLabel", () => {
  it("stamps the label into the field, keeping other keys and replacing an existing stamp", () => {
    const args = { text: "x", metadata: { topic: "a", [RECORD_LABEL_KEY]: { integrity: "trusted", confidentiality: "public", writer: "admin" } } };
    expect(stampRecordLabel(args, "metadata", TAINTED, "mon")).toEqual({
      text: "x",
      metadata: { topic: "a", [RECORD_LABEL_KEY]: { integrity: "untrusted", confidentiality: "private", writer: "mon" } },
    });
    expect(args.metadata[RECORD_LABEL_KEY].writer).toBe("admin"); // input not mutated
  });

  it("creates the field, and refuses one that is not an object", () => {
    expect(stampRecordLabel({}, "metadata", TAINTED, "mon")).toHaveProperty(["metadata", RECORD_LABEL_KEY, "writer"], "mon");
    expect(() => stampRecordLabel({ metadata: "note" }, "metadata", TAINTED, "mon")).toThrow(/not an object/);
  });
});

describe("readRecordLabels", () => {
  const stamp = (integrity: string, writer: string) => ({ [RECORD_LABEL_KEY]: { integrity, confidentiality: "public", writer } });

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
