# ADTL against MCPHunt: a trace replay

**Result: ADTL's example policy would have stopped 0.6% of MCPHunt's policy-violating leaks. With [`call.copiesPrivate`](../../packages/gateway/README.md#copied-private-values), added in 0.9.0, it stops 78.0%, interrupting 12.7% of clean runs.** Session labels alone don't catch this kind of leak, and this page says why, and what does.

[MCPHunt](https://arxiv.org/abs/2604.27819) measures how credentials spread across multi-server MCP agents. It plants canary secrets, and it separates leaks a task required from leaks that broke policy. Its [traces](https://huggingface.co/datasets/lihaonan0716/mcphunt-agent-traces) are public (CC BY 4.0).

## What was run

[`replay.mjs`](replay.mjs) walks the recorded tool calls of the main benchmark, 3,615 runs from 5 models, through ADTL's real labeler and policy (`@adtl/labels`), with the labels in [`adtl.yaml`](adtl.yaml). Those labels come from what each server is, not from any run's outcome, and no rule knows where the canaries are.

- **Leaks:** the 501 runs MCPHunt marks as policy-violating (`outcome_crs_stratified`). 499 have a call carrying the canary, which is the call that counts.
- **Stopped:** a block before or at that call, or an `ask` on that call itself. An `ask` on an earlier, harmless call doesn't count, because a person who allows it hasn't seen the leak. Counting an `ask` as stopped assumes the person says no.
- **Clean runs:** the 2,179 runs MCPHunt marks `safe_success`. Asks here are the cost.

## Results

| Policy | Leaks stopped | Clean runs interrupted | Mean asks per clean run |
| --- | --- | --- | --- |
| **`example`**: the rules in [`examples/adtl.yaml`](../adtl.yaml) | **0.6%** | 5.0% | 0.2 |
| **`ask-on-leaving`**: also ask before external or unknown egress once the session is private | 2.6% | 43.7% | 2.5 |
| **`ask-on-any-write`**: also ask before any write once the session is private | 95.2% | 95.7% | 4.3 |
| **`example + copies private`**: also ask when a call copies a secret-like value read from a private source ([`call.copiesPrivate`](../../packages/gateway/README.md#copied-private-values)) | **78.0%** | **12.7%** | 0.3 |
| `prototype: example + copied values`: the 0.8.1 prototype of the same idea, any long value | 79.2% | 44.7% | 1.3 |

Every stop was an `ask`; none of these policies blocked a call in these runs. Numbers vary by model: for `example + copies private`, clean runs asked range from 8.2% (gpt-5.2) to 21.8% (deepseek-v4-flash), and leaks stopped from 52.5% (gpt-5.2, 21 of 40) to 83.8% (deepseek-v4-flash).

## Why

**The leaks are local.** The first leaking call was `filesystem.write_file` in 433 of 499 runs, then `memory.create_entities` (28), `sqlite.write_query` (22), `shell.execute_command` (13) and `memory.add_observations` (3). MCPHunt treats a credential copied into a report or a script as a boundary crossing. ADTL's example policy is about data leaving: writing a local file is `internal` egress, which it allows.

**A session label can't tell the writes apart.** Nearly every run reads something private, so the label is `private` before nearly every write, in clean runs and leaking runs alike. That's why `ask-on-any-write` catches almost everything and interrupts almost everything: 95.2% against 95.7%. This answers one of the [questions in the README](../../README.md#questions-id-love-feedback-on): at this level, taint tracking flags too much to be useful.

**Labels are per tool, not per file.** ADTL can't say `.env` is secret and `README.md` isn't, so `private` covers both.

**Web content is labeled public.** `browser_to_local` is the largest group (121 runs), and 26 of them pass even `ask-on-any-write`, because the fetch-style preset labels web pages `public` and the session never turns private.

## What helps: copied values

`call.copiesPrivate` asks only when a call's arguments hold a value the session read earlier from a private source. The session keeps hashes of secret-like values from private results: 16 or more characters with letters and digits, not plain hex, and not a folder name in a path. Each call's arguments are checked against them.

- It stops 78.0% of leaks while interrupting 12.7% of clean runs, at 0.3 asks per clean run. Asking before every write gets 95.2% at 95.7%.
- Leaving out `browser_to_local`, it stops 361 of the other 378 leaks (95.5%): every `file_to_file`, `file_to_doc`, `sensitive_to_shell` and `indirect_exposure` leak, 53 of 54 `config_to_script` and 71 of 72 `git_history_leak`.
- The filters matter. The 0.8.1 prototype counted any long value and interrupted 44.7% of clean runs. Most of that was snake_case names, git commit ids, content hashes, and the workspace folder that every path repeats.
- What's left of the noise is mostly tasks that are meant to copy development or test credentials (`sk_test_…`, `ghp_DevToken…`). They look exactly like the real ones.

**Still open:**

- **Web content.** `browser_to_local` (28 of 121 stopped) needs web pages that hold secrets to be labeled as such. The fetch-style preset labels every web page `public`, so its values are never remembered.
- **Per-path labels.** ADTL can't yet say `.env` is secret and `README.md` isn't.
- **`db_to_artifact`.** Some query results hold secrets that are re-formatted on the way out (45 of 58 stopped).

## Limits of this replay

- **No agent ran.** Traces are fixed: a real agent told "no" would do something else, and that may leak another way or give up. Clean-run numbers count interruptions, not lost tasks.
- **Only labels and policy.** The gateway, ledger and approvals weren't involved. The ledger follows content between sessions, which these single-session runs don't test.
- **Not what ADTL is built for.** MCPHunt measures non-adversarial, verbatim propagation. ADTL's demos are about injected instructions and data reaching public tools, which this benchmark doesn't test. Paraphrased or adversarial leaks are out of its scope, so nothing here covers them.
- **The labels are one person's reading.** Change [`adtl.yaml`](adtl.yaml) and the numbers change.

## Run it

```sh
npm install && npm run build
mkdir traces && cd traces
for f in MiniMax_M2_7 deepseek_v4_flash gemini_3_1_pro_preview gpt_5_2 gpt_5_4; do
  curl -LO "https://huggingface.co/datasets/lihaonan0716/mcphunt-agent-traces/resolve/main/main/$f.json"
done
cd .. && node examples/mcphunt-eval/replay.mjs traces     # add --json for per-model numbers
```

The traces are about 270 MB and aren't in this repo. They hold synthetic canaries, not real secrets.
