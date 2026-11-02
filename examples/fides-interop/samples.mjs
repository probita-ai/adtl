// Write the labels ADTL emits in fides-gateway's form, for check.py to validate
// with fides-gateway's own model. Run from the repo root after `npm run build`:
//   node examples/fides-interop/samples.mjs > /tmp/adtl-fides-samples.json
import { FIDES_LABELS_KEY, attachLabel, fidesLabels, toFidesLabel } from "@adtl/labels";

const labels = [
  { integrity: "trusted", confidentiality: "public", origins: [] },
  { integrity: "untrusted", confidentiality: "public", origins: [] },
  { integrity: "unknown", confidentiality: "private", origins: [] },
  { integrity: "untrusted", confidentiality: "secret", origins: [] },
];
const readers = ["alice"];

const samples = labels.map((label) => ({
  adtl: label,
  expected: toFidesLabel(label, readers),
  // An outgoing tool call, as the adtl.label request mutator stamps it.
  request: { name: "send_message_to_channel", arguments: { channel: "general", text: "hi" }, _meta: { [FIDES_LABELS_KEY]: fidesLabels(label, readers) } },
  // A labeled tool result, as the adtl.label response mutator returns it.
  result: attachLabel({ content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } }, label, { fides: { readers } }),
}));
process.stdout.write(`${JSON.stringify(samples, null, 2)}\n`);
