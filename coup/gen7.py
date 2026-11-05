"""
Gen 7: observation encoder, belief classes and network.

Changes from Gen 5 (coup_env.CoupEnv._encode_state, 70 dims):
- my hand is encoded per slot, so LOSE_CARD_0 / LOSE_CARD_1 know which card they
  give up (Gen 5 only saw card counts and chose blind);
- coins are scaled, with explicit 3 / 7 thresholds; unseen copies per role
  (3 minus my hand minus every revealed card) are given directly;
- the decision context says which action a block would counter and whether a
  challenge is against a block of my own action;
- my previous decision is fed back in (the LSTM otherwise never sees what it did);
- the last 4 history entries use one-hot action types.

The network adds a belief head: a distribution over the opponent's hidden hand
(15 two-card multisets + 5 single cards), trained by cross-entropy against the
true hand. Classes ruled out by card counting are masked exactly.
"""

import itertools
from typing import List, Optional, Sequence

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from .game import Card, ActionType
from .coup_env import RLAction, ACT_TYPE_TO_RL, BLOCK_TO_RL

CARD_IDX = {Card.DUKE: 0, Card.ASSASSIN: 1, Card.CAPTAIN: 2, Card.AMBASSADOR: 3, Card.CONTESSA: 4}
CARDS = [Card.DUKE, Card.ASSASSIN, Card.CAPTAIN, Card.AMBASSADOR, Card.CONTESSA]
DEC_IDX = {'ACT': 0, 'CHL': 1, 'CTR': 2, 'LOSE': 3}
CTR_IDX = {ActionType.FOREIGN_AID: 0, ActionType.ASSASSINATE: 1, ActionType.STEAL: 2}
HIST_LEN = 4
HIST_DIM = 12  # 7 action one-hot, actor is me, blocked, challenged, challenge won, card lost

OBS_DIM = 127
HIDDEN = 256
NUM_ACTIONS = RLAction.SIZE

# Belief classes: unordered two-card hands (i <= j), then single cards.
HANDS2 = list(itertools.combinations_with_replacement(range(5), 2))  # 15
NUM_BELIEF = len(HANDS2) + 5  # 20
# membership[k, r] = copies of role r in hand class k
MEMBERSHIP = np.zeros((NUM_BELIEF, 5), dtype=np.float32)
for k, (i, j) in enumerate(HANDS2):
    MEMBERSHIP[k, i] += 1
    MEMBERSHIP[k, j] += 1
for r in range(5):
    MEMBERSHIP[len(HANDS2) + r, r] = 1


def hand_class(cards: Sequence[Card]) -> int:
    """Belief class index of a (1- or 2-card) hand."""
    idx = sorted(CARD_IDX[c] for c in cards)
    if len(idx) == 2:
        return HANDS2.index(tuple(idx))
    return len(HANDS2) + idx[0]


def belief_mask(unseen: Sequence[int], opp_influence: int) -> np.ndarray:
    """Hand classes the opponent can hold given unseen copies per role."""
    m = np.zeros(NUM_BELIEF, dtype=bool)
    if opp_influence == 2:
        for k, (i, j) in enumerate(HANDS2):
            m[k] = unseen[i] >= 2 if i == j else (unseen[i] >= 1 and unseen[j] >= 1)
    elif opp_influence == 1:
        for r in range(5):
            m[len(HANDS2) + r] = unseen[r] >= 1
    return m


def encode(req_type: str, view: dict, ctx, prev_action: int):
    """Gen 7 observation, action mask and belief mask for one decision."""
    obs = np.zeros(OBS_DIM, dtype=np.float32)
    mask = np.zeros(NUM_ACTIONS, dtype=bool)
    opp = view['opponents'][0]
    me = view['player_id']
    my_cards = view['my_cards']

    for s, c in enumerate(my_cards[:2]):
        obs[s * 5 + CARD_IDX[c]] = 1.0
        obs[10 + CARD_IDX[c]] += 1.0
    my_coins, opp_coins = view['my_coins'], opp['coins']
    obs[15] = my_coins / 10.0
    obs[16] = opp_coins / 10.0
    obs[17] = float(my_coins >= 3)
    obs[18] = float(my_coins >= 7)
    obs[19] = float(opp_coins >= 3)
    obs[20] = float(opp_coins >= 7)
    obs[21] = len(my_cards) / 2.0
    obs[22] = opp['influence_count'] / 2.0
    seen = [0] * 5
    for c in my_cards:
        seen[CARD_IDX[c]] += 1
    for c in view['my_revealed']:
        obs[23 + CARD_IDX[c]] += 1.0
        seen[CARD_IDX[c]] += 1
    for c in opp['revealed']:
        obs[28 + CARD_IDX[c]] += 1.0
        seen[CARD_IDX[c]] += 1
    unseen = [3 - s for s in seen]
    for r in range(5):
        obs[33 + r] = unseen[r] / 3.0
    for c in view['my_claimed_cards']:
        obs[38 + CARD_IDX[c]] = 1.0
    for c in opp['claimed_cards']:
        obs[43 + CARD_IDX[c]] = 1.0
    obs[48] = view['my_caught_bluff_count'] / 2.0
    obs[49] = opp['caught_bluff_count'] / 2.0

    obs[50 + DEC_IDX[req_type]] = 1.0
    history = view['action_history']
    if req_type == 'CHL':
        obs[54 + CARD_IDX[ctx]] = 1.0
        # in 1v1 a claim on my challenge prompt is a block iff the turn is mine
        if history and history[-1]['player'] == me:
            obs[59] = 1.0
    elif req_type == 'CTR':
        obs[60 + CTR_IDX[ctx['action']]] = 1.0
    if prev_action >= 0:
        obs[63 + prev_action] = 1.0

    base = 78
    for h in history[-HIST_LEN:]:
        obs[base + ACT_TYPE_TO_RL[h['action']]] = 1.0
        obs[base + 7] = float(h['player'] == me)
        obs[base + 8] = float(bool(h['was_blocked']))
        obs[base + 9] = float(bool(h['was_challenged']))
        obs[base + 10] = float(bool(h['challenge_won']))
        obs[base + 11] = float(bool(h['card_lost']))
        base += HIST_DIM
    obs[126] = min(view['turn_number'], 40) / 20.0

    if req_type == 'ACT':
        for a in ctx:
            mask[ACT_TYPE_TO_RL[a.action_type]] = True
    elif req_type == 'CHL':
        mask[RLAction.YES] = True
        mask[RLAction.NO] = True
    elif req_type == 'CTR':
        mask[RLAction.NO] = True
        for c in ctx['cards']:
            mask[BLOCK_TO_RL[c]] = True
    elif req_type == 'LOSE':
        mask[RLAction.LOSE_CARD_0] = True
        if len(my_cards) > 1:
            mask[RLAction.LOSE_CARD_1] = True

    return obs, mask, belief_mask(unseen, opp['influence_count'])


class CoupGen7(nn.Module):
    """
    fc(127→256) → fc(256→256) → LSTM(256) → actor (15), critic (tanh), belief (20).

    `priv_critic` sees the opponent's true hand as well; it is used only to compute
    advantages during training and is not exported.
    """

    def __init__(self, input_dim=OBS_DIM, hidden_dim=HIDDEN, num_actions=NUM_ACTIONS):
        super().__init__()
        self.fc1 = nn.Linear(input_dim, hidden_dim)
        self.fc2 = nn.Linear(hidden_dim, hidden_dim)
        self.lstm = nn.LSTM(hidden_dim, hidden_dim, batch_first=True)
        self.actor = nn.Linear(hidden_dim, num_actions)
        self.critic = nn.Linear(hidden_dim, 1)
        self.belief = nn.Linear(hidden_dim, NUM_BELIEF)
        self.priv_critic = nn.Sequential(
            nn.Linear(hidden_dim + 10, 128), nn.ReLU(), nn.Linear(128, 1))

    def forward(self, x, hidden=None):
        """x: (batch, seq, obs). Returns logits, value, belief logits, lstm_out, hidden."""
        b, t, _ = x.shape
        feat = F.relu(self.fc2(F.relu(self.fc1(x.reshape(b * t, -1))))).reshape(b, t, -1)
        out, hidden = self.lstm(feat, hidden)
        return (self.actor(out), torch.tanh(self.critic(out)).squeeze(-1),
                self.belief(out), out, hidden)

    def priv_value(self, lstm_out, opp_hand):
        """opp_hand: (..., 10) slot one-hots of the opponent's hidden cards."""
        return torch.tanh(self.priv_critic(torch.cat([lstm_out, opp_hand], -1))).squeeze(-1)

    def reset_hidden(self, batch_size=1, device='cpu'):
        h = torch.zeros(1, batch_size, self.lstm.hidden_size, device=device)
        return (h, h.clone())


def opp_hand_feature(cards: List[Card]) -> np.ndarray:
    f = np.zeros(10, dtype=np.float32)
    for s, c in enumerate(cards[:2]):
        f[s * 5 + CARD_IDX[c]] = 1.0
    return f


def masked_belief(logits: torch.Tensor, bmask: torch.Tensor) -> torch.Tensor:
    return logits.masked_fill(~bmask, -1e9)


def role_marginals(probs: np.ndarray) -> np.ndarray:
    """P(opponent holds at least one copy of each role) from class probabilities."""
    return probs @ (MEMBERSHIP > 0).astype(np.float32)
