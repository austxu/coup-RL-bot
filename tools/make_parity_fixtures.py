"""
Record reference games from the Python engine + PyTorch bot so the browser
port (web/src/engine, web/src/bot) can be checked against them.

    .venv/bin/python tools/make_parity_fixtures.py            # committed subset
    .venv/bin/python tools/make_parity_fixtures.py --games 400 --out /tmp/big.json.gz

Every game records:
  * every deck order produced by random.shuffle (initial deal, challenge
    reshuffles, exchange returns) so the TS engine can replay the same deck;
  * every decision prompt in engine order (who was asked what, with which
    options), a snapshot of the full state at that moment, and the answer;
  * for PPO decisions: encoded observation, action mask, logits and value from
    the original float32 weights and from the float16-quantised weights the
    browser ships (each with its own persistent LSTM state);
  * the final state, winner and action history.
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
    ap.add_argument("--games", type=int, default=24, help="games per matchup")
    ap.add_argument("--out", default=os.path.join(ROOT, "web/test/fixtures/parity.json.gz"))
    args = ap.parse_args()

    torch.set_num_threads(1)
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
