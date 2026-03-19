import queue
from typing import List, Optional
from .game import Card, ActionType, Action
from .agents import Agent

class WebAgent(Agent):
    """
    An agent that communicates with a web client via Socket.IO.
    It blocks on a queue until the client sends a response.
    """
    def __init__(self, sid: str, emit_fn, name: str = "Human"):
        self.sid = sid
        self.emit_fn = emit_fn
        self.name = name
        self.input_queue = queue.Queue()

    def receive_input(self, data):
        """Called by the web server when the client sends input."""
        self.input_queue.put(data)

    def _prepare_view(self, view: dict) -> dict:
        """Convert Enums to strings for JSON serialization."""
        v = dict(view)
        v['my_cards'] = [c.value for c in v['my_cards']]
        v['my_revealed'] = [c.value for c in v['my_revealed']]
        v['my_claimed_cards'] = [c.value for c in v['my_claimed_cards']]
        
        for opp in v['opponents']:
            opp['revealed'] = [c.value for c in opp['revealed']]
            opp['claimed_cards'] = [c.value for c in opp['claimed_cards']]
            
        # action_history might contain ActionType Enum
        v['action_history'] = []
        for h in view['action_history']:
            entry = dict(h)
            entry['action'] = entry['action'].value
            v['action_history'].append(entry)
        return v

    def _request_input(self, prompt_type: str, view: dict, additional_data: dict = None) -> dict:
        payload = {
            'type': prompt_type,
            'view': self._prepare_view(view)
        }
        if additional_data:
            payload.update(additional_data)
            
        self.emit_fn('game_prompt', payload, room=self.sid)
        return self.input_queue.get() # Block until web client responds

    def choose_action(self, view: dict, legal_actions: List[Action]) -> Action:
        actions_data = [{
            'action_type': a.action_type.value,
            'target_idx': a.target_idx
        } for a in legal_actions]
        
        res = self._request_input('choose_action', view, {'legal_actions': actions_data})
        idx = res.get('choice_index', 0)
        return legal_actions[idx]

    def choose_challenge(self, view: dict, claimer_idx: int, claimed_card: Card) -> bool:
        res = self._request_input('choose_challenge', view, {
            'claimer_idx': claimer_idx,
            'claimed_card': claimed_card.value
        })
        return res.get('challenge', False)

    def choose_counteraction(self, view: dict, actor_idx: int, action_type: ActionType, blocking_cards: List[Card]) -> Optional[Card]:
        cards_str = [c.value for c in blocking_cards]
        res = self._request_input('choose_counteraction', view, {
            'actor_idx': actor_idx,
            'action_type': action_type.value,
            'blocking_cards': cards_str
        })
        choice_idx = res.get('choice_index', -1)
        if choice_idx >= 0 and choice_idx < len(blocking_cards):
            return blocking_cards[choice_idx]
        return None

    def choose_challenge_counter(self, view: dict, blocker_idx: int, blocking_card: Card) -> bool:
        res = self._request_input('choose_challenge_counter', view, {
            'blocker_idx': blocker_idx,
            'blocking_card': blocking_card.value
        })
        return res.get('challenge', False)

    def choose_card_to_lose(self, view: dict) -> int:
        res = self._request_input('choose_card_to_lose', view, {})
        return res.get('choice_index', 0)

    def choose_exchange_cards(self, view: dict, all_cards: List[Card], num_to_keep: int) -> List[int]:
        cards_str = [c.value for c in all_cards]
        res = self._request_input('choose_exchange_cards', view, {
            'all_cards': cards_str,
            'num_to_keep': num_to_keep
        })
        indices = res.get('choice_indices', [0, 1][:num_to_keep])
        return sorted(indices)
