"""Gen 7 policy as a CoupGame agent (same decision semantics as PPOAgent)."""

from typing import List, Optional

import numpy as np
import torch

from .agents import Agent
from .game import Card, ActionType, Action
from .coup_env import RLAction, RL_TO_ACT_TYPE, RL_TO_BLOCK
from . import gen7

EXCH_VAL = {Card.DUKE: 5, Card.ASSASSIN: 4, Card.CAPTAIN: 3, Card.AMBASSADOR: 2, Card.CONTESSA: 1}


class Gen7Agent(Agent):
    """
    Samples from the masked softmax with one LSTM state for the whole game, and
    feeds its previous decision back in. After each decision `last` holds the
    observation, masks, logits, value and belief (for fixtures and analysis).
    """

    def __init__(self, model: gen7.CoupGen7, name: str = "PPO-AI"):
        self.model = model
        self.model.eval()
        self.name = name
        self.hidden = model.reset_hidden(1)
        self.prev = -1
        self.last = None

    @classmethod
    def from_path(cls, path: str, name: str = "PPO-AI"):
        m = gen7.CoupGen7()
        m.load_state_dict(torch.load(path, map_location="cpu"))
        return cls(m, name)

    def _decide(self, req: str, view: dict, ctx) -> int:
        obs, mask, bmask = gen7.encode(req, view, ctx, self.prev)
        x = torch.from_numpy(obs).view(1, 1, -1)
        with torch.no_grad():
            logits, value, blog, _, self.hidden = self.model(x, self.hidden)
            logits = logits.view(-1)
            masked = logits.masked_fill(~torch.from_numpy(mask), -1e9)
            idx = int(torch.distributions.Categorical(logits=masked).sample())
            bl = gen7.masked_belief(blog.view(-1), torch.from_numpy(bmask))
            belief = torch.softmax(bl, -1).numpy() if bmask.any() else np.zeros(gen7.NUM_BELIEF, np.float32)
        self.last = dict(req=req, obs=obs, mask=mask, bmask=bmask, prev=self.prev,
                         logits=logits.numpy().copy(), value=float(value.view(-1)[0]),
                         belief_logits=blog.view(-1).numpy().copy(), belief=belief, choice=idx)
        self.prev = idx
        return idx

    def choose_action(self, view: dict, legal_actions: List[Action]) -> Action:
        t = RL_TO_ACT_TYPE.get(self._decide('ACT', view, legal_actions))
        for a in legal_actions:
            if a.action_type == t:
                return a
        return legal_actions[0]

    def choose_challenge(self, view: dict, claimer_idx: int, claimed_card: Card) -> bool:
        return self._decide('CHL', view, claimed_card) == RLAction.YES

    def choose_counteraction(self, view: dict, actor_idx: int, action_type: ActionType,
                             blocking_cards: List[Card]) -> Optional[Card]:
        idx = self._decide('CTR', view, {'action': action_type, 'cards': blocking_cards})
        return None if idx == RLAction.NO else RL_TO_BLOCK.get(idx)

    def choose_card_to_lose(self, view: dict) -> int:
        return 0 if self._decide('LOSE', view, None) == RLAction.LOSE_CARD_0 else 1

    def choose_exchange_cards(self, view: dict, all_cards: List[Card], num_to_keep: int) -> List[int]:
        ranked = sorted(range(len(all_cards)), key=lambda i: -EXCH_VAL[all_cards[i]])
        return sorted(ranked[:num_to_keep])
