"""
Export PPO weights for the browser bot (Gen5 and Gen7).

Matrices are stored as float16 (halves the payload); 1-D biases stay float32
because they are tiny and keep the quantisation error confined to the matmuls.

    .venv/bin/python tools/export_weights.py                       # Gen5
    .venv/bin/python tools/export_weights.py --model gen7 --checkpoint versions/gen7/ppo_model_gen7.pt

Writes web/src/model/<model>.bin and web/src/model/<model>.json. Vite
fingerprints the .bin when it is imported with `?url`, so it can be cached
forever. Gen7's training-only `priv_critic.*` head is not exported.
"""

import argparse
import hashlib
import json
import os

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ORDER = [
    "fc1.weight", "fc1.bias",
    "fc2.weight", "fc2.bias",
    "lstm.weight_ih_l0", "lstm.weight_hh_l0", "lstm.bias_ih_l0", "lstm.bias_hh_l0",
    "actor.weight", "actor.bias",
    "critic.weight", "critic.bias",
]

MODELS = {
    "gen5": dict(order=ORDER, inputDim=70, numBelief=0,
                 checkpoint=os.path.join(ROOT, "versions/gen5/ppo_model_gen5.pt")),
    "gen7": dict(order=ORDER + ["belief.weight", "belief.bias"], inputDim=127, numBelief=20,
                 checkpoint=os.path.join(ROOT, "versions/gen7/ppo_model_gen7.pt"),
                 training_only=("priv_critic.",)),
}


def storage_dtype(tensor: torch.Tensor) -> str:
    return "float16" if tensor.dim() >= 2 else "float32"


def quantised_state_dict(state_dict):
    """The exact weights the browser sees, as float32 tensors (parity reference)."""
    out = {}
    for name, t in state_dict.items():
        out[name] = t.half().float() if storage_dtype(t) == "float16" else t.clone()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=sorted(MODELS), default="gen5")
    ap.add_argument("--checkpoint", help="state dict to export (default: the model's checkpoint in versions/)")
    ap.add_argument("--out", default=os.path.join(ROOT, "web/src/model"))
    args = ap.parse_args()
    spec = MODELS[args.model]
    ckpt = os.path.abspath(args.checkpoint or spec["checkpoint"])

    sd = torch.load(ckpt, map_location="cpu")
    skip = spec.get("training_only", ())
    keys = [k for k in sd.keys() if not k.startswith(skip)] if skip else list(sd.keys())
    assert keys == spec["order"], f"unexpected state dict layout: {list(sd.keys())}"
    os.makedirs(args.out, exist_ok=True)

    blob = bytearray()
    tensors = []
    for name in spec["order"]:
        t = sd[name].detach().cpu()
        dtype = storage_dtype(t)
        arr = t.numpy().astype(np.float16 if dtype == "float16" else np.float32)
        # keep every tensor 4-byte aligned so Float32Array views work in the browser
        while len(blob) % 4:
            blob.append(0)
        tensors.append({
            "name": name,
            "shape": list(t.shape),
            "dtype": dtype,
            "offset": len(blob),
            "length": int(arr.size),
        })
        blob.extend(arr.astype(arr.dtype.newbyteorder("<")).tobytes())

    bin_path = os.path.join(args.out, f"{args.model}.bin")
    with open(bin_path, "wb") as f:
        f.write(blob)

    rel = os.path.relpath(ckpt, ROOT)
    manifest = {
        "format": "coup-lstm-ppo/1",
        "model": args.model,
        "source": rel if not rel.startswith("..") else os.path.basename(ckpt),
        "inputDim": spec["inputDim"],
        "hiddenDim": 256,
        "numActions": 15,
    }
    if spec["numBelief"]:
        manifest["numBelief"] = spec["numBelief"]
    manifest.update({
        "byteLength": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "tensors": tensors,
    })
    with open(os.path.join(args.out, f"{args.model}.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print(f"wrote {bin_path} ({len(blob):,} bytes)")


if __name__ == "__main__":
    main()
