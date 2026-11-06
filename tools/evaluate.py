"""
Head-to-head evaluation of the browser bots against every baseline that still
loads, using the Python engine (coup/game.py).

    .venv/bin/python tools/evaluate.py --games 5000

Gen 7 (coup.gen7_agent.Gen7Agent) and Gen 5 (coup.ppo_agent.PPOAgent) both
sample from the masked policy exactly as deployed, with a fresh LSTM state per
game. Seats alternate every game; every game is seeded (python `random` + torch).
Earlier PPO generations are fed through the encoders they were trained with
(coup/legacy.py loads them from git history).

For Gen 7 the belief head is scored at every decision against the opponent's
true hidden hand, next to a card-counting-only baseline (every hand consistent
with the unseen cards, weighted by how many ways it could be dealt).

Writes web/public/data/evaluation.json.
"""

import argparse
import datetime
import json
import math
import os
import random
import sys
import time
from collections import defaultdict
from multiprocessing import Pool

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from coup.game import CoupGame  # noqa: E402
from coup.agents import HeuristicAgent, RandomAgent  # noqa: E402
from coup.zoo_agents import ZooAgent  # noqa: E402
from coup.cfr_agent import CFRAgent  # noqa: E402
from coup.ppo_agent import PPOAgent  # noqa: E402
from coup.gen7_agent import Gen7Agent  # noqa: E402
from coup.legacy import load_generation  # noqa: E402
from coup import gen7  # noqa: E402

OUT = os.path.join(ROOT, "web/public/data/evaluation.json")
GEN7 = os.path.join(ROOT, "versions/gen7/ppo_model_gen7.pt")

OPPONENTS = [
    dict(id="random", label="Uniform random",
         description="RandomAgent: uniformly random legal actions; challenges 15%, blocks 25% of the time."),
    dict(id="zoo", label="Random zoo profiles",
         description="ZooAgent.random_profile(): a fresh scripted personality each game (bluff, challenge, "
                     "block and income rates drawn uniformly)."),
    dict(id="heuristic", label="Rule-based heuristic",
         description="HeuristicAgent: never bluffs, always blocks when it holds the card, challenges with "
                     "two copies."),
    dict(id="cfr", label="CFR (MCCFR, 5M iterations)",
         description="CFRAgent with versions/gen1-4/strategy_5m.json; abstracted info sets, uniform on unseen sets."),
    dict(id="gen1", label="PPO Gen 1", description="23-dim observation, LSTM 64, trained vs zoo profiles."),
    dict(id="gen2", label="PPO Gen 2", description="Gen 1 fine-tuned vs zoo + heuristic."),
    dict(id="gen3", label="PPO Gen 3", description="23-dim observation, 1M episodes of self-play."),
    dict(id="gen4", label="PPO Gen 4", description="35-dim observation with claim / caught-bluff memory."),
    dict(id="gen5", label="PPO Gen 5", description="70-dim observation, LSTM 256, 3.5M episodes; the previous browser bot."),
]

SUBJECTS = {
    "gen7": "Gen 7: league-trained PPO + LSTM with a belief head (versions/gen7/ppo_model_gen7.pt).",
    "gen5": "Gen 5: PPO + LSTM, 75% self-play (versions/gen5/ppo_model_gen5.pt).",
}

_cache = {}


def legacy_agent(gen, label):
    if gen not in _cache:
        _cache[gen] = load_generation(gen)
    model, env = _cache[gen]
    agent = PPOAgent.from_model(model, torch.device("cpu"))
    agent.env_helper = env  # the encoder this generation was trained with
    agent.name = label
    return agent


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
    return legacy_agent(oid, spec["label"])


def make_subject(subject, ckpt):
    if subject == "gen5":
        return legacy_agent("gen5", "PPO Gen 5")
    if "gen7" not in _cache:
        m = gen7.CoupGen7()
        m.load_state_dict(torch.load(ckpt, map_location="cpu"))
        m.eval()
        _cache["gen7"] = m
    return Gen7Agent(_cache["gen7"])


def wilson(k, n, z=1.959964):
    if n == 0:
        return [0.0, 0.0]
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 4), round(c + h, 4)]


# -----------------------------------------------------------------------------
# Belief scoring
# -----------------------------------------------------------------------------

def counting_prior(unseen, influence):
    """Card-counting-only belief: hands weighted by the ways to draw them from the unseen cards."""
    p = np.zeros(gen7.NUM_BELIEF)
    if influence == 2:
        for k, (i, j) in enumerate(gen7.HANDS2):
            p[k] = unseen[i] * (unseen[i] - 1) / 2 if i == j else unseen[i] * unseen[j]
    else:
        for r in range(5):
            p[len(gen7.HANDS2) + r] = unseen[r]
    return p / p.sum()


class BeliefLog:
    BINS = 10

    def __init__(self):
        self.n = 0
        self.ll = self.ll0 = 0.0
        self.top1 = self.top10 = 0
        self.brier = self.brier0 = 0.0
        self.rel = np.zeros((self.BINS, 3))  # sum pred, sum outcome, count

    def add(self, belief, obs, truth_cards):
        infl = len(truth_cards)
        unseen = [int(round(obs[33 + r] * 3)) for r in range(5)]
        prior = counting_prior(unseen, infl)
        k = gen7.hand_class(truth_cards)
        self.n += 1
        self.ll += -math.log(max(belief[k], 1e-12))
        self.ll0 += -math.log(max(prior[k], 1e-12))
        self.top1 += int(np.argmax(belief) == k)
        self.top10 += int(np.argmax(prior) == k)
        roles = gen7.role_marginals(belief)
        roles0 = gen7.role_marginals(prior.astype(np.float32))
        y = np.array([float(any(gen7.CARD_IDX[c] == r for c in truth_cards)) for r in range(5)])
        self.brier += float(((roles - y) ** 2).mean())
        self.brier0 += float(((roles0 - y) ** 2).mean())
        b = np.minimum((roles * self.BINS).astype(int), self.BINS - 1)
        for r in range(5):
            self.rel[b[r]] += (roles[r], y[r], 1)

    def merge(self, o):
        self.n += o.n
        self.ll += o.ll
        self.ll0 += o.ll0
        self.top1 += o.top1
        self.top10 += o.top10
        self.brier += o.brier
        self.brier0 += o.brier0
        self.rel += o.rel

    def summary(self, reliability=False):
        n = max(self.n, 1)
        out = dict(decisions=self.n,
                   logLoss=round(self.ll / n, 4), priorLogLoss=round(self.ll0 / n, 4),
                   top1=round(self.top1 / n, 4), priorTop1=round(self.top10 / n, 4),
                   roleBrier=round(self.brier / n, 4), priorRoleBrier=round(self.brier0 / n, 4))
        if reliability:
            out["reliability"] = [
                dict(lo=b / self.BINS, hi=(b + 1) / self.BINS,
                     predicted=round(s / c, 4) if c else None, observed=round(o / c, 4) if c else None,
                     n=int(c))
                for b, (s, o, c) in enumerate(self.rel)]
        return out


def run_matchup(args):
    subject, spec, games, seed0, ckpt = args
    torch.set_num_threads(1)
    wins = losses = draws = 0
    turns = 0
    belief = BeliefLog()
    t0 = time.time()
    for i in range(games):
        random.seed(seed0 + i)
        torch.manual_seed(seed0 + i)
        me = make_subject(subject, ckpt)
        if hasattr(me, "hidden_state"):
            me.hidden_state = me.model.reset_hidden(1, "cpu")
        opp = make_opponent(spec)
        if hasattr(opp, "hidden_state"):
            opp.hidden_state = opp.model.reset_hidden(1, "cpu")
        seat = i % 2
        agents = [me, opp] if seat == 0 else [opp, me]
        game = CoupGame(agents, num_players=2)
        if isinstance(me, Gen7Agent):
            decide = me._decide

            def scored(req, view, ctx, decide=decide, game=game, me=me, seat=seat):
                truth = list(game.state.players[1 - seat].cards)
                idx = decide(req, view, ctx)
                if truth and me.last["bmask"].any():
                    belief.add(me.last["belief"], me.last["obs"], truth)
                return idx

            me._decide = scored
        w = game.play_game()
        turns += game.state.turn_number
        if w is None:
            draws += 1
        elif w == seat:
            wins += 1
        else:
            losses += 1
    return dict(id=spec["id"], wins=wins, losses=losses, draws=draws, turns=turns, games=games,
                seconds=time.time() - t0, belief=belief)


def evaluate(subject, games, workers, ckpt, chunk=500):
    opps = [o for o in OPPONENTS if o["id"] != subject]
    jobs = []
    for k, spec in enumerate(opps):
        for c in range(0, games, chunk):
            jobs.append((subject, spec, min(chunk, games - c), 100_000 * (k + 1) + c, ckpt))
    with Pool(workers) as pool:
        parts = pool.map(run_matchup, jobs)
    results, beliefs = [], {}
    for spec in opps:
        ps = [p for p in parts if p["id"] == spec["id"]]
        w = sum(p["wins"] for p in ps)
        n = sum(p["games"] for p in ps)
        bl = BeliefLog()
        for p in ps:
            bl.merge(p["belief"])
        beliefs[spec["id"]] = bl
        r = {k: spec[k] for k in ("id", "label", "description")}
        r.update(games=n, wins=w, losses=sum(p["losses"] for p in ps), draws=sum(p["draws"] for p in ps),
                 winRate=round(w / n, 4), ci95=wilson(w, n),
                 avgTurns=round(sum(p["turns"] for p in ps) / n, 2),
                 seconds=round(sum(p["seconds"] for p in ps), 1))
        print(f"{subject} vs {spec['id']:>9}: {w}/{n} = {w / n:.3f} {r['ci95']} avg {r['avgTurns']} turns", flush=True)
        results.append(r)
    return results, beliefs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--games", type=int, default=5000)
    ap.add_argument("--workers", type=int, default=min(12, os.cpu_count() or 1))
    ap.add_argument("--checkpoint", default=GEN7)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    g7, beliefs = evaluate("gen7", args.games, args.workers, args.checkpoint)
    g5, _ = evaluate("gen5", args.games, args.workers, args.checkpoint)

    pooled = BeliefLog()
    for b in beliefs.values():
        pooled.merge(b)
    payload = {
        "asOf": datetime.date.today().isoformat(),
        "model": "gen7",
        "policy": "Samples from the masked softmax (as deployed), fresh LSTM state each game.",
        "engine": "coup/game.py, 1v1; seats alternate every game; seeded per game.",
        "metric": "winRate = wins / games for the evaluated model; ci95 is the 95% Wilson score interval; "
                  "draws (500-turn cap) count as non-wins. avgTurns counts both players' turns.",
        "games": sum(r["games"] for r in g7 + g5),
        "gamesPerOpponent": args.games,
        "opponents": g7,
        "models": [
            dict(id="gen7", description=SUBJECTS["gen7"], opponents=g7),
            dict(id="gen5", description=SUBJECTS["gen5"], opponents=g5),
        ],
        "belief": {
            "description": "Gen 7's belief head, scored at every Gen 7 decision in the games above against the "
                           "opponent's true hidden hand (20 classes: 15 two-card hands + 5 single cards). "
                           "'prior' is card counting alone: every hand consistent with the cards Gen 7 cannot "
                           "see, weighted by the number of ways it could be dealt.",
            "metrics": "logLoss: mean -ln p(true hand), nats. top1: most likely hand is exactly right. "
                       "roleBrier: mean squared error of P(holds >= 1 of each role). reliability: role "
                       "probabilities binned by prediction vs observed frequency (pooled).",
            "pooled": pooled.summary(reliability=True),
            "byOpponent": {k: v.summary() for k, v in beliefs.items()},
        },
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)
        f.write("\n")
    p = payload["belief"]["pooled"]
    print(f"belief: log loss {p['logLoss']} vs prior {p['priorLogLoss']}; top-1 {p['top1']} vs {p['priorTop1']}; "
          f"role Brier {p['roleBrier']} vs {p['priorRoleBrier']}")
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
