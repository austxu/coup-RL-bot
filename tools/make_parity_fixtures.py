"""
Record reference games from the Python engine + PyTorch bot so the browser
port (web/src/engine, web/src/bot) can be checked against them.

    .venv/bin/python tools/make_parity_fixtures.py            # committed subset
    .venv/bin/python tools/make_parity_fixtures.py --games 400 --out /tmp/big.json.gz
    .venv/bin/python tools/make_parity_fixtures.py --model gen7 \
        --checkpoint versions/gen7/ppo_model_gen7.pt          # parity7.json.gz

Every game records:
  * every deck order produced by random.shuffle (initial deal, challenge
    reshuffles, exchange returns) so the TS engine can replay the same deck;
  * every decision prompt in engine order (who was asked what, with which
    options), a snapshot of the full state at that moment, and the answer;
  * for PPO decisions: encoded observation, action mask, logits and value from
    the original float32 weights and from the float16-quantised weights the
    browser ships (each with its own persistent LSTM state);
  * the final state, winner and action history.

Gen7 (`--model gen7`) games are Gen7 vs random, zoo, heuristic, Gen5 and Gen7
vs Gen7. Each Gen7 decision additionally records its belief mask, the previous
decision fed back in (`prev`) and belief logits from both weight sets.
"""

import argparse
import gzip
import json
import os
import random
import sys

import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

import coup.game as game_mod  # noqa: E402
from coup.game import CoupGame, Card, ActionType  # noqa: E402
from coup.agents import Agent, RandomAgent, HeuristicAgent  # noqa: E402
from coup.zoo_agents import ZooAgent  # noqa: E402
from coup.coup_env import CoupEnv, RLAction, RL_TO_ACT_TYPE, RL_TO_BLOCK  # noqa: E402
from coup.ppo_model import CoupLSTMPPO  # noqa: E402
from coup import gen7  # noqa: E402
from export_weights import quantised_state_dict  # noqa: E402

MODEL_PATH = os.path.join(ROOT, "versions/gen5/ppo_model_gen5.pt")


# -----------------------------------------------------------------------------
# Recording hooks
# -----------------------------------------------------------------------------

class RecordingRandom:
    """Stands in for the `random` module inside coup.game and logs shuffles."""

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.shuffles = []

    def shuffle(self, seq):
        self.rng.shuffle(seq)
        self.shuffles.append([c.value for c in seq])


def snapshot(game: CoupGame) -> dict:
    s = game.state
    return {
        "turn": s.turn_number,
        "cur": s.current_player_idx,
        "deck": [c.value for c in s.court_deck],
        "players": [{
            "coins": p.coins,
            "cards": [c.value for c in p.cards],
            "revealed": [c.value for c in p.revealed],
            "claimed": sorted(c.value for c in p.claimed_cards),
            "caught": p.caught_bluff_count,
        } for p in s.players],
    }


def history(game: CoupGame) -> list:
    return [{
        "turn": h["turn"], "player": h["player"], "action": h["action"].value,
        "target": h["target"], "was_blocked": h["was_blocked"],
        "was_challenged": h["was_challenged"], "challenge_won": h["challenge_won"],
        "card_lost": h["card_lost"],
    } for h in game.state.action_history]


class Recorder(Agent):
    """Wraps an agent and logs every prompt the engine sends it."""

    def __init__(self, inner, seat: int, log: list, game_ref: list):
        self.inner = inner
        self.seat = seat
        self.log = log
        self.game_ref = game_ref
        self.name = getattr(inner, "name", f"P{seat}")

    def _pending_snapshot(self):
        # The state must be captured *before* the agent acts (agents never mutate
        # state, but keep it explicit).
        return snapshot(self.game_ref[0])

    def choose_action(self, view, legal_actions):
        before = self._pending_snapshot()
        a = self.inner.choose_action(view, legal_actions)
        idx = next(i for i, x in enumerate(legal_actions) if x is a or
                   (x.action_type == a.action_type and x.target_idx == a.target_idx))
        self._push({"k": "act", "legal": [[x.action_type.value, x.target_idx] for x in legal_actions]},
                   idx, before)
        return a

    def choose_challenge(self, view, claimer_idx, claimed_card):
        before = self._pending_snapshot()
        r = bool(self.inner.choose_challenge(view, claimer_idx, claimed_card))
        self._push({"k": "chl", "claimer": claimer_idx, "card": claimed_card.value}, r, before)
        return r

    def choose_counteraction(self, view, actor_idx, action_type, blocking_cards):
        before = self._pending_snapshot()
        r = self.inner.choose_counteraction(view, actor_idx, action_type, blocking_cards)
        self._push({"k": "blk", "actor": actor_idx, "action": action_type.value,
                    "cards": [c.value for c in blocking_cards]},
                   r.value if r is not None else None, before)
        return r

    def choose_card_to_lose(self, view):
        before = self._pending_snapshot()
        r = int(self.inner.choose_card_to_lose(view))
        self._push({"k": "lose"}, r, before)
        return r

    def choose_exchange_cards(self, view, all_cards, num_to_keep):
        before = self._pending_snapshot()
        r = list(self.inner.choose_exchange_cards(view, all_cards, num_to_keep))
        self._push({"k": "exch", "all": [c.value for c in all_cards], "keep": num_to_keep}, r, before)
        return r

    def _push(self, prompt, answer, state):
        entry = {"p": self.seat, **prompt, "answer": answer, "state": state}
        bot = getattr(self.inner, "last_decision", None)
        if bot is not None:
            if getattr(self.inner, "record", True):
                entry["bot"] = bot
            self.inner.last_decision = None
        self.log.append(entry)


class TracedPPO(Agent):
    """
    Mirrors coup.ppo_agent.PPOAgent exactly, but additionally runs the float16
    model in lock-step (own hidden state) and records both outputs.
    """

    def __init__(self, model32, model16, rng: torch.Generator, name="PPO-AI"):
        self.m32, self.m16 = model32, model16
        self.h32 = model32.reset_hidden(1, "cpu")
        self.h16 = model16.reset_hidden(1, "cpu")
        self.env_helper = CoupEnv()
        self.rng = rng
        self.name = name
        self.last_decision = None

    def _decide(self, req_type, view, context):
        obs, mask = self.env_helper._encode_state({"req_type": req_type, "view": view, "context": context})
        x = torch.FloatTensor(obs).unsqueeze(0)
        m = torch.BoolTensor(mask).view(1, 1, -1)
        with torch.no_grad():
            l32, v32, self.h32 = self.m32(x, self.h32)
            l16, v16, self.h16 = self.m16(x, self.h16)
            raw32 = l32.clone()
            l32[~m] = -1e9
            # Same distribution as PPOAgent's Categorical(logits).sample(), seeded.
            idx = int(torch.multinomial(torch.softmax(l32.view(-1), 0), 1, generator=self.rng).item())
        assert mask[idx]
        assert all(float(o).is_integer() for o in obs)
        self.last_decision = {
            "req": req_type,
            "obs": [int(o) for o in obs],
            "mask": [int(b) for b in mask],
            "logits32": [round(float(v), 6) for v in raw32.view(-1)],
            "value32": round(float(v32.view(-1)[0]), 6),
            "logits16": [round(float(v), 6) for v in l16.view(-1)],
            "value16": round(float(v16.view(-1)[0]), 6),
            "choice": idx,
        }
        return idx

    def choose_action(self, view, legal_actions):
        idx = self._decide("ACT", view, legal_actions)
        act_type = RL_TO_ACT_TYPE[idx]
        return next(a for a in legal_actions if a.action_type == act_type)

    def choose_challenge(self, view, claimer_idx, claimed_card):
        return self._decide("CHL", view, claimed_card) == RLAction.YES

    def choose_counteraction(self, view, actor_idx, action_type, blocking_cards):
        idx = self._decide("CTR", view, {"action": action_type, "cards": blocking_cards})
        return None if idx == RLAction.NO else RL_TO_BLOCK.get(idx)

    def choose_card_to_lose(self, view):
        return 0 if self._decide("LOSE", view, None) == RLAction.LOSE_CARD_0 else 1

    def choose_exchange_cards(self, view, all_cards, num_to_keep):
        val = {Card.DUKE: 5, Card.ASSASSIN: 4, Card.CAPTAIN: 3, Card.AMBASSADOR: 2, Card.CONTESSA: 1}
        ranked = sorted(range(len(all_cards)), key=lambda i: -val[all_cards[i]])
        return sorted(ranked[:num_to_keep])


# -----------------------------------------------------------------------------

def load_models():
    sd = torch.load(MODEL_PATH, map_location="cpu")
    m32 = CoupLSTMPPO(70, 256, 15)
    m32.load_state_dict(sd)
    m16 = CoupLSTMPPO(70, 256, 15)
    m16.load_state_dict(quantised_state_dict(sd))
    m32.eval()
    m16.eval()
    return m32, m16


def f32(v) -> float:
    """Shortest decimal that round-trips to the same float32 (Math.fround in TS)."""
    r = float(str(np.float32(v)))
    assert np.float32(r) == np.float32(v)
    return int(r) if r.is_integer() else r


class TracedGen7(Agent):
    """
    Mirrors coup.gen7_agent.Gen7Agent exactly (one LSTM state per game, previous
    decision fed back in, masked-softmax sampling, fixed exchange heuristic), but
    also runs the float16 model in lock-step (own hidden state) and records both.
    """

    def __init__(self, model32, model16, rng: torch.Generator, name="Gen7"):
        self.m32, self.m16 = model32, model16
        self.h32 = model32.reset_hidden(1)
        self.h16 = model16.reset_hidden(1)
        self.prev = -1
        self.rng = rng
        self.name = name
        self.last_decision = None

    def _decide(self, req, view, ctx):
        obs, mask, bmask = gen7.encode(req, view, ctx, self.prev)
        x = torch.from_numpy(obs).view(1, 1, -1)
        with torch.no_grad():
            l32, v32, b32, _, self.h32 = self.m32(x, self.h32)
            l16, v16, b16, _, self.h16 = self.m16(x, self.h16)
            l32, b32, l16, b16 = (t.view(-1) for t in (l32, b32, l16, b16))
            masked = l32.masked_fill(~torch.from_numpy(mask), -1e9)
            # Same distribution as Gen7Agent's Categorical(logits).sample(), seeded.
            idx = int(torch.multinomial(torch.softmax(masked, 0), 1, generator=self.rng).item())
        assert mask[idx]
        r6 = lambda t: [round(float(v), 6) for v in t]  # noqa: E731
        self.last_decision = {
            "req": req,
            "obs": [f32(o) for o in obs],
            "mask": [int(b) for b in mask],
            "bmask": [int(b) for b in bmask],
            "prev": self.prev,
            "logits32": r6(l32), "value32": round(float(v32.view(-1)[0]), 6), "belief32": r6(b32),
            "logits16": r6(l16), "value16": round(float(v16.view(-1)[0]), 6), "belief16": r6(b16),
            "choice": idx,
        }
        self.prev = idx
        return idx

    def choose_action(self, view, legal_actions):
        t = RL_TO_ACT_TYPE.get(self._decide("ACT", view, legal_actions))
        return next((a for a in legal_actions if a.action_type == t), legal_actions[0])

    def choose_challenge(self, view, claimer_idx, claimed_card):
        return self._decide("CHL", view, claimed_card) == RLAction.YES

    def choose_counteraction(self, view, actor_idx, action_type, blocking_cards):
        idx = self._decide("CTR", view, {"action": action_type, "cards": blocking_cards})
        return None if idx == RLAction.NO else RL_TO_BLOCK.get(idx)

    def choose_card_to_lose(self, view):
        return 0 if self._decide("LOSE", view, None) == RLAction.LOSE_CARD_0 else 1

    def choose_exchange_cards(self, view, all_cards, num_to_keep):
        val = {Card.DUKE: 5, Card.ASSASSIN: 4, Card.CAPTAIN: 3, Card.AMBASSADOR: 2, Card.CONTESSA: 1}
        ranked = sorted(range(len(all_cards)), key=lambda i: -val[all_cards[i]])
        return sorted(ranked[:num_to_keep])


def load_gen7(path):
    sd = torch.load(path, map_location="cpu")
    m32 = gen7.CoupGen7()
    m32.load_state_dict(sd)
    m16 = gen7.CoupGen7()
    m16.load_state_dict(quantised_state_dict(sd))
    m32.eval()
    m16.eval()
    return m32, m16


def play7(seed: int, matchup: str, g7, g5) -> dict:
    py_rng = random.Random(seed)
    torch_rng = torch.Generator().manual_seed(seed)
    random.seed(seed * 7919 + 1)
    rec_random = RecordingRandom(py_rng)
    game_mod.random = rec_random

    def bot(name="Gen7"):
        return TracedGen7(*g7, torch_rng, name)

    def gen5_opp():
        a = TracedPPO(*g5, torch_rng, "Gen5")
        a.record = False  # opponent only; Gen5 has its own fixture
        return a

    opp = {
        "random": lambda: RandomAgent(),
        "zoo": lambda: ZooAgent.random_profile(),
        "heuristic": lambda: HeuristicAgent(),
        "gen5": gen5_opp,
        "gen7": lambda: bot("Gen7-B"),
    }[matchup]()
    inner = [bot(), opp]
    if py_rng.random() < 0.5:
        inner.reverse()
    for a in inner:
        if not hasattr(a, "name"):
            a.name = type(a).__name__

    log, game_ref = [], [None]
    agents = [Recorder(a, i, log, game_ref) for i, a in enumerate(inner)]
    g = CoupGame(agents, num_players=2)
    game_ref[0] = g
    winner = g.play_game()
    game_mod.random = random

    return {
        "seed": seed,
        "matchup": matchup,
        "seats": ["gen7" if isinstance(a, TracedGen7) else matchup for a in inner],
        "shuffles": rec_random.shuffles,
        "decisions": log,
        "final": snapshot(g),
        "history": history(g),
        "winner": winner,
    }


def main_gen7(args):
    g7 = load_gen7(args.checkpoint or os.path.join(ROOT, "versions/gen7/ppo_model_gen7.pt"))
    g5 = load_models()
    games = []
    seed = 7000
    for matchup in ("random", "zoo", "heuristic", "gen5", "gen7"):
        for _ in range(args.games):
            games.append(play7(seed, matchup, g7, g5))
            seed += 1
    out = args.out or os.path.join(ROOT, "web/test/fixtures/parity7.json.gz")
    n_bot = sum(1 for g in games for d in g["decisions"] if "bot" in d)
    n_dec = sum(len(g["decisions"]) for g in games)
    payload = {"version": 1, "model": "gen7", "classes": [list(h) for h in gen7.HANDS2], "games": games}
    os.makedirs(os.path.dirname(out), exist_ok=True)
    data = json.dumps(payload, separators=(",", ":")).encode()
    with gzip.open(out, "wb", compresslevel=9) as f:
        f.write(data)
    vs = [g for g in games if g["matchup"] != "gen7"]
    wins = sum(1 for g in vs if g["winner"] is not None and g["seats"][g["winner"]] == "gen7")
    print(f"{len(games)} games, {n_dec} decisions ({n_bot} Gen7), "
          f"{len(data)/1e6:.2f} MB json -> {os.path.getsize(out)/1e6:.2f} MB gz; "
          f"Gen7 won {wins}/{len(vs)} vs other bots")


def play(seed: int, matchup: str, m32, m16) -> dict:
    py_rng = random.Random(seed)
    torch_rng = torch.Generator().manual_seed(seed)
    # Agents in coup.agents / coup.zoo_agents use the global `random` module.
    random.seed(seed * 7919 + 1)
    rec_random = RecordingRandom(py_rng)
    game_mod.random = rec_random

    def ppo(name="PPO-AI"):
        return TracedPPO(m32, m16, torch_rng, name)

    opp = {
        "random": lambda: RandomAgent(),
        "zoo": lambda: ZooAgent.random_profile(),
        "heuristic": lambda: HeuristicAgent(),
        "ppo": lambda: ppo("PPO-B"),
    }[matchup]()
    inner = [ppo(), opp]
    if py_rng.random() < 0.5:
        inner.reverse()
    for i, a in enumerate(inner):
        if not hasattr(a, "name"):
            a.name = type(a).__name__

    log, game_ref = [], [None]
    agents = [Recorder(a, i, log, game_ref) for i, a in enumerate(inner)]
    g = CoupGame(agents, num_players=2)
    game_ref[0] = g
    winner = g.play_game()
    game_mod.random = random

    return {
        "seed": seed,
        "matchup": matchup,
        "seats": ["ppo" if isinstance(a, TracedPPO) else matchup for a in inner],
        "shuffles": rec_random.shuffles,
        "decisions": log,
        "final": snapshot(g),
        "history": history(g),
        "winner": winner,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", choices=("gen5", "gen7"), default="gen5")
    ap.add_argument("--checkpoint", help="Gen7 state dict (default versions/gen7/ppo_model_gen7.pt)")
    ap.add_argument("--games", type=int, help="games per matchup (default 24 for gen5, 20 for gen7)")
    ap.add_argument("--out", help="default web/test/fixtures/parity.json.gz (gen7: parity7.json.gz)")
    args = ap.parse_args()

    torch.set_num_threads(1)
    if args.model == "gen7":
        args.games = args.games or 20
        return main_gen7(args)
    args.games = args.games or 24
    args.out = args.out or os.path.join(ROOT, "web/test/fixtures/parity.json.gz")
    m32, m16 = load_models()
    games = []
    seed = 1000
    for matchup in ("random", "zoo", "heuristic", "ppo"):
        for _ in range(args.games):
            games.append(play(seed, matchup, m32, m16))
            seed += 1

    n_bot = sum(1 for g in games for d in g["decisions"] if "bot" in d)
    n_dec = sum(len(g["decisions"]) for g in games)
    payload = {"version": 1, "model": "gen5", "games": games}
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    data = json.dumps(payload, separators=(",", ":")).encode()
    with gzip.open(args.out, "wb", compresslevel=9) as f:
        f.write(data)
    vs = [g for g in games if g["matchup"] != "ppo"]
    wins = sum(1 for g in vs if g["winner"] is not None and g["seats"][g["winner"]] == "ppo")
    print(f"{len(games)} games, {n_dec} decisions ({n_bot} PPO), "
          f"{len(data)/1e6:.2f} MB json -> {os.path.getsize(args.out)/1e6:.2f} MB gz; "
          f"PPO won {wins}/{len(vs)} vs scripted bots")


if __name__ == "__main__":
    main()
