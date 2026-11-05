"""
Export the Gen5 PPO weights for the browser bot.

Matrices are stored as float16 (halves the payload); 1-D biases stay float32
because they are tiny and keep the quantisation error confined to the matmuls.

    .venv/bin/python tools/export_weights.py

Writes web/src/model/gen5.bin and web/src/model/gen5.json. Vite fingerprints
the .bin when it is imported with `?url`, so it can be cached forever.
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
    ap.add_argument("--model", default=os.path.join(ROOT, "versions/gen5/ppo_model_gen5.pt"))
    ap.add_argument("--out", default=os.path.join(ROOT, "web/src/model"))
    args = ap.parse_args()

    sd = torch.load(args.model, map_location="cpu")
    assert list(sd.keys()) == ORDER, f"unexpected state dict layout: {list(sd.keys())}"
    os.makedirs(args.out, exist_ok=True)

    blob = bytearray()
    tensors = []
    for name in ORDER:
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

    bin_path = os.path.join(args.out, "gen5.bin")
    with open(bin_path, "wb") as f:
        f.write(blob)

    manifest = {
        "format": "coup-lstm-ppo/1",
        "model": "gen5",
        "source": os.path.relpath(args.model, ROOT),
        "inputDim": 70,
        "hiddenDim": 256,
        "numActions": 15,
        "byteLength": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "tensors": tensors,
    }
    with open(os.path.join(args.out, "gen5.json"), "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    print(f"wrote {bin_path} ({len(blob):,} bytes)")


if __name__ == "__main__":
    main()
