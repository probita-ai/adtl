"""Check ADTL's fides-gateway labels with fides-gateway's own model.

Run inside a fides-gateway checkout's environment (it needs its dependencies):

    cd /path/to/fides-gateway
    uv sync --extra dev            # or: pip install -e '.[dev]'
    python /path/to/adtl/examples/fides-interop/check.py /tmp/adtl-fides-samples.json

It validates each sample with fides-gateway's Pydantic models, resolves the
effective label of the request's name and arguments the way its policy engine
does, and checks that both equal the label ADTL meant to send.
"""

import json
import sys

# Imported from the current directory: run this from the fides-gateway checkout.
sys.path.insert(0, ".")
from lattice import IFCLabels  # noqa: E402
from policy_engine import (  # noqa: E402
    IFC_LABELS_META_PREFIX,
    LabeledToolCallParams,
    LabeledToolResult,
    _make_label_extension,
)


def same(a: dict, b: dict) -> bool:
    return IFCLabels(**a) == IFCLabels(**b)


def main(path: str) -> int:
    samples = json.load(open(path))
    failures = 0
    for s in samples:
        name = f"{s['adtl']['integrity']}/{s['adtl']['confidentiality']}"
        expected = s["expected"]

        LabeledToolCallParams.model_validate(s["request"])
        label = _make_label_extension(s["request"], s["request"]["_meta"][IFC_LABELS_META_PREFIX])
        for path_ in ("$['name']", "$['arguments']", "$['arguments']['text']", "$"):
            got = label(path_)
            if not same(got, expected):
                failures += 1
                print(f"FAIL {name} request {path_}: {got} != {expected}")

        LabeledToolResult.model_validate(s["result"])
        for key, value in s["result"]["_meta"][IFC_LABELS_META_PREFIX].items():
            if not same(value, expected):
                failures += 1
                print(f"FAIL {name} result {key}: {value} != {expected}")

        if failures == 0:
            print(f"ok   {name}: {expected}")
    print("all samples match" if failures == 0 else f"{failures} mismatches")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
