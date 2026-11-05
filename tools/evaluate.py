"""
Head-to-head evaluation of the deployed Gen5 bot (coup.ppo_agent.PPOAgent,
sampling from the masked policy exactly as in production) against every
baseline that still loads, using the Python engine.

    .venv/bin/python tools/evaluate.py --games 2000

Seats alternate every game; every game is seeded (python `random` + torch).
Writes web/public/data/evaluation.json.

Earlier PPO generations need the observation encoders they were trained with;
those are loaded from git history (commits below) so their inputs are exact.
"""

import argparse
import datetime
import importlib.util
import json
import math
import os
import random
import subprocess
import sys
import time
from multiprocessing import Pool

import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from coup.game import CoupGame  # noqa: E402
from coup.agents import HeuristicAgent, RandomAgent  # noqa: E402
from coup.zoo_agents import ZooAgent  # noqa: E402
from coup.cfr_agent import CFRAgent  # noqa: E402
from coup.ppo_agent import PPOAgent  # noqa: E402
from coup.ppo_model import CoupLSTMPPO  # noqa: E402

OUT = os.path.join(ROOT, "web/public/data/evaluation.json")
GEN5 = os.path.join(ROOT, "versions/gen5/ppo_model_gen5.pt")

# commit whose coup/coup_env.py holds the encoder each legacy checkpoint expects
LEGACY_ENV = {23: "274d3c1", 35: "e36aaaa"}

OPPONENTS = [
    dict(id="random", label="Uniform random",
         description="RandomAgent: uniformly random legal actions; challenges 15%, blocks 25% of the time."),
    dict(id="zoo", label="Random zoo profiles",
         description="ZooAgent.random_profile(): a fresh scripted personality each game (bluff, challenge, "
                     "block and income rates drawn uniformly). 15% of Gen5's training games."),
    dict(id="heuristic", label="Rule-based heuristic",
         description="HeuristicAgent: never bluffs, always blocks when it holds the card, challenges with "
                     "two copies. 10% of Gen5's training games."),
    dict(id="cfr", label="CFR (MCCFR, 5M iterations)",
         description="CFRAgent with versions/gen1-4/strategy_5m.json; abstracted info sets, uniform on unseen sets."),
    dict(id="gen1", label="PPO Gen 1", description="23-dim observation, LSTM 64, trained vs zoo profiles.",
         path="versions/gen1-4/ppo_model_gen1.pt", obs=23),
    dict(id="gen2", label="PPO Gen 2", description="Gen 1 fine-tuned vs zoo + heuristic.",
         path="versions/gen1-4/ppo_model_gen2.pt", obs=23),
    dict(id="gen3", label="PPO Gen 3", description="23-dim observation, 1M episodes of self-play.",
         path="versions/gen1-4/ppo_model_gen3.pt", obs=23),
    dict(id="gen4", label="PPO Gen 4", description="35-dim observation with claim / caught-bluff memory.",
         path="versions/gen1-4/ppo_model_gen4.pt", obs=35),
]


def legacy_env(obs_dim: int):
    """Import the historical coup_env.py as a module inside the `coup` package."""
    commit = LEGACY_ENV[obs_dim]
    src = subprocess.check_output(["git", "-C", ROOT, "show", f"{commit}:coup/coup_env.py"], text=True)
    name = f"coup._legacy_env_{obs_dim}"
    spec = importlib.util.spec_from_loader(name, loader=None)
    mod = importlib.util.module_from_spec(spec)
    mod.__package__ = "coup"
    exec(compile(src, f"{commit}:coup/coup_env.py", "exec"), mod.__dict__)
    sys.modules[name] = mod
    return mod.CoupEnv()


def load_ppo(path: str, obs_dim: int, hidden: int):
    model = CoupLSTMPPO(input_dim=obs_dim, hidden_dim=hidden, num_actions=15)
    model.load_state_dict(torch.load(os.path.join(ROOT, path), map_location="cpu"))
    model.eval()
    return model


_cache = {}


def make_opponent(spec):
    oid = spec["id"]
    if oid == "random":
        return RandomAgent()
    if oid == "zoo":
        return ZooAgent.random_profile()
    if oid == "heuristic":
        return HeuristicAgent()
    if oid == "cfr":
        if "cfr" not in _cache:
            _cache["cfr"] = CFRAgent.from_file(os.path.join(ROOT, "versions/gen1-4/strategy_5m.json"))
        return _cache["cfr"]
    if oid not in _cache:
        _cache[oid] = (load_ppo(spec["path"], spec["obs"], 64), legacy_env(spec["obs"]))
    model, env = _cache[oid]
    agent = PPOAgent.from_model(model, torch.device("cpu"))
    agent.env_helper = env  # the encoder this generation was trained with
    agent.name = spec["label"]
    return agent


def wilson(k: int, n: int, z: float = 1.959964):
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


def run_matchup(args):
    spec, games, seed0 = args
    torch.set_num_threads(1)
    gen5_model = load_ppo(os.path.relpath(GEN5, ROOT), 70, 256)
    wins = losses = draws = 0
    turns = 0
    t0 = time.time()
    for i in range(games):
        random.seed(seed0 + i)
        torch.manual_seed(seed0 + i)
        gen5 = PPOAgent.from_model(gen5_model, torch.device("cpu"))  # fresh LSTM state per game
        opp = make_opponent(spec)
        if hasattr(opp, "hidden_state"):
            opp.hidden_state = opp.model.reset_hidden(1, "cpu")
        seat = i % 2
        agents = [gen5, opp] if seat == 0 else [opp, gen5]
        game = CoupGame(agents, num_players=2)
        w = game.play_game()
        turns += game.state.turn_number
        if w is None:
            draws += 1
        elif w == seat:
            wins += 1
        else:
            losses += 1
    out = {k: spec[k] for k in ("id", "label", "description")}
    out.update(games=games, wins=wins, losses=losses, draws=draws,
               winRate=round(wins / games, 4), ci95=wilson(wins, games),
               avgTurns=round(turns / games, 2), seconds=round(time.time() - t0, 1))
    print(f"{spec['id']:>10}: {wins}/{games} = {wins/games:.3f} {out['ci95']} avg {out['avgTurns']} turns "
          f"({out['seconds']}s)", flush=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=2000)
    ap.add_argument("--workers", type=int, default=min(8, os.cpu_count() or 1))
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    jobs = [(spec, args.games, 100_000 * (k + 1)) for k, spec in enumerate(OPPONENTS)]
    with Pool(args.workers) as pool:
        results = pool.map(run_matchup, jobs)

    payload = {
        "asOf": datetime.date.today().isoformat(),
        "model": "gen5",
        "policy": "Samples from the masked softmax (as deployed), fresh LSTM state each game.",
        "engine": "coup/game.py, 1v1; seats alternate every game; seeded per game.",
        "metric": "winRate = Gen5 wins / games; ci95 is the 95% Wilson score interval; "
                  "draws (500-turn cap) count as non-wins. avgTurns counts both players' turns.",
        "games": sum(r["games"] for r in results),
        "gamesPerOpponent": args.games,
        "opponents": results,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)
        f.write("\n")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
