from typing import List, Optional
from .game import Card, ActionType, Action
from .agents import Agent

class HumanAgent(Agent):
    """
    An agent that prompts a human user for input via the terminal.
    """
    def __init__(self, name: str = "Player"):
        self.name = name

    def _display_view(self, view: dict):
        print(f"\n--- {self.name}'s TURN ---")
        print(f"Your Cards: {[c.name for c in view['my_cards']]}")
        print(f"Your Coins: {view['my_coins']}")
        
        opp = view['opponents'][0]
        print(f"Opponent {opp['player_id']}: {opp['influence_count']} influence, {opp['coins']} coins")
        if opp['revealed']:
            print(f"Opponent's Revealed Cards: {[c.name for c in opp['revealed']]}")
        print("-" * 25)

    def choose_action(self, view: dict, legal_actions: List[Action]) -> Action:
        self._display_view(view)
        print("Legal Actions:")
        for i, action in enumerate(legal_actions):
            target_str = f" target {action.target_idx}" if action.target_idx is not None else ""
            print(f"{i}: {action.action_type.name}{target_str}")
        
        while True:
            try:
                choice = int(input(f"Select action (0-{len(legal_actions)-1}): "))
                if 0 <= choice < len(legal_actions):
                    return legal_actions[choice]
            except ValueError:
                pass
            print("Invalid selection.")

    def choose_challenge(self, view: dict, claimer_idx: int, claimed_card: Card) -> bool:
        print(f"\nPlayer {claimer_idx} claims {claimed_card.name}.")
        while True:
            choice = input("Challenge? (y/n): ").lower()
            if choice == 'y': return True
            if choice == 'n': return False

    def choose_counteraction(self, view: dict, actor_idx: int, action_type: ActionType, blocking_cards: List[Card]) -> Optional[Card]:
        print(f"\nPlayer {actor_idx} is attempting {action_type.name}.")
        print("You can block with:", [c.name for c in blocking_cards])
        while True:
            print("Available options:")
            print("0: Don't block")
            for i, card in enumerate(blocking_cards):
                print(f"{i+1}: Block with {card.name}")
            
            try:
                choice = int(input(f"Select option (0-{len(blocking_cards)}): "))
                if choice == 0: return None
                if 1 <= choice <= len(blocking_cards):
                    return blocking_cards[choice-1]
            except ValueError:
                pass
            print("Invalid selection.")

    def choose_challenge_counter(self, view: dict, blocker_idx: int, blocking_card: Card) -> bool:
        print(f"\nPlayer {blocker_idx} blocks with {blocking_card.name}.")
        while True:
            choice = input("Challenge block? (y/n): ").lower()
            if choice == 'y': return True
            if choice == 'n': return False

    def choose_card_to_lose(self, view: dict) -> int:
        print("\nYou lost influence! Choose a card to reveal:")
        for i, card in enumerate(view['my_cards']):
            print(f"{i}: {card.name}")
        
        while True:
            try:
                choice = int(input(f"Select card (0-{len(view['my_cards'])-1}): "))
                if 0 <= choice < len(view['my_cards']):
                    return choice
            except ValueError:
                pass
            print("Invalid selection.")

    def choose_exchange_cards(self, view: dict, all_cards: List[Card], num_to_keep: int) -> List[int]:
        print(f"\nExchanging cards. You must keep {num_to_keep} cards.")
        print("Your options:")
        for i, card in enumerate(all_cards):
            print(f"{i}: {card.name}")
        
        while True:
            try:
                choice_str = input(f"Enter {num_to_keep} indices separated by spaces (e.g. 0 1): ")
                indices = [int(x) for x in choice_str.split()]
                if len(indices) == num_to_keep and all(0 <= i < len(all_cards) for i in indices) and len(set(indices)) == num_to_keep:
                    return sorted(indices)
            except ValueError:
                pass
            print("Invalid selection.")
