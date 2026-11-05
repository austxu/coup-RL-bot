"""
Loaders for earlier PPO generations with the exact observation encoders they
were trained with (Gen 1-3: 23 dims, Gen 4: 35 dims, Gen 5: 70 dims). The old
encoders are read from git history so their inputs are bit-for-bit original.
"""

import importlib.util
import os
import subprocess
import sys

import torch

from .ppo_model import CoupLSTMPPO

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# commit whose coup/coup_env.py holds the encoder each legacy checkpoint expects
LEGACY_ENV = {23: "274d3c1", 35: "e36aaaa"}

GENERATIONS = {
    "gen1": dict(path="versions/gen1-4/ppo_model_gen1.pt", obs=23, hidden=64),
    "gen2": dict(path="versions/gen1-4/ppo_model_gen2.pt", obs=23, hidden=64),
    "gen3": dict(path="versions/gen1-4/ppo_model_gen3.pt", obs=23, hidden=64),
    "gen4": dict(path="versions/gen1-4/ppo_model_gen4.pt", obs=35, hidden=64),
    "gen5": dict(path="versions/gen5/ppo_model_gen5.pt", obs=70, hidden=256),
}

_envs = {}


def legacy_env(obs_dim: int):
    """An env object whose `_encode_state(msg)` is the encoder for `obs_dim`."""
    if obs_dim in _envs:
        return _envs[obs_dim]
    if obs_dim == 70:
        from .coup_env import CoupEnv
        env = CoupEnv()
    else:
        commit = LEGACY_ENV[obs_dim]
        src = subprocess.check_output(["git", "-C", ROOT, "show", f"{commit}:coup/coup_env.py"], text=True)
        name = f"coup._legacy_env_{obs_dim}"
        spec = importlib.util.spec_from_loader(name, loader=None)
        mod = importlib.util.module_from_spec(spec)
        mod.__package__ = "coup"
        exec(compile(src, f"{commit}:coup/coup_env.py", "exec"), mod.__dict__)
        sys.modules[name] = mod
        env = mod.CoupEnv()
    _envs[obs_dim] = env
    return env


def load_generation(gen: str):
    """(model, encoder env) for one of GENERATIONS."""
    spec = GENERATIONS[gen]
    model = CoupLSTMPPO(input_dim=spec["obs"], hidden_dim=spec["hidden"], num_actions=15)
    model.load_state_dict(torch.load(os.path.join(ROOT, spec["path"]), map_location="cpu"))
    model.eval()
    return model, legacy_env(spec["obs"])
