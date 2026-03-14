"""
Core game logic — no web/WebSocket concerns here.

State machine per room:
  LOBBY → STORYTELLER_PICKS → OTHERS_SUBMIT → VOTING → ROUND_END → (next round) → GAME_OVER
"""

from __future__ import annotations
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional
import random

from deck import shuffled_deck

HAND_SIZE = 6
MIN_PLAYERS = 3
MAX_PLAYERS = 6
DEFAULT_ROUNDS = 5


class Phase(str, Enum):
    LOBBY = "lobby"
    STORYTELLER_PICKS = "storyteller_picks"
    OTHERS_SUBMIT = "others_submit"
    VOTING = "voting"
    ROUND_END = "round_end"
    GAME_OVER = "game_over"


@dataclass
class Player:
    id: str          # websocket session id
    name: str
    score: int = 0
    hand: list[dict] = field(default_factory=list)
    # card submitted to the table this round (card dict or None)
    submitted_card: Optional[dict] = None
    # card id this player voted for this round
    voted_for: Optional[int] = None

    def to_public(self) -> dict:
        """Safe representation to broadcast (no hand contents)."""
        return {"id": self.id, "name": self.name, "score": self.score}


@dataclass
class Room:
    code: str
    total_rounds: int = DEFAULT_ROUNDS
    current_round: int = 0
    phase: Phase = Phase.LOBBY
    players: list[Player] = field(default_factory=list)
    storyteller_index: int = 0
    clue: str = ""
    # cards on the table: list of {"card": dict, "owner_id": str}
    table: list[dict] = field(default_factory=list)
    deck: list[dict] = field(default_factory=list)
    # round-end scoring breakdown for display
    last_round_scores: dict = field(default_factory=dict)
    host_id: str = ""

    # ------------------------------------------------------------------
    # Lobby helpers
    # ------------------------------------------------------------------

    def add_player(self, player_id: str, name: str) -> Player:
        if len(self.players) >= MAX_PLAYERS:
            raise ValueError("Room is full")
        if self.phase != Phase.LOBBY:
            raise ValueError("Game already started")
        if any(p.id == player_id for p in self.players):
            raise ValueError("Already in room")
        p = Player(id=player_id, name=name)
        self.players.append(p)
        return p

    def remove_player(self, player_id: str) -> None:
        self.players = [p for p in self.players if p.id != player_id]

    def get_player(self, player_id: str) -> Optional[Player]:
        return next((p for p in self.players if p.id == player_id), None)

    @property
    def storyteller(self) -> Player:
        return self.players[self.storyteller_index % len(self.players)]

    # ------------------------------------------------------------------
    # Game flow
    # ------------------------------------------------------------------

    def start_game(self) -> None:
        if len(self.players) < MIN_PLAYERS:
            raise ValueError(f"Need at least {MIN_PLAYERS} players")
        self.deck = shuffled_deck()
        self.current_round = 1
        self.storyteller_index = 0
        self._deal_hands()
        self.phase = Phase.STORYTELLER_PICKS

    def _deal_hands(self) -> None:
        for player in self.players:
            while len(player.hand) < HAND_SIZE and self.deck:
                player.hand.append(self.deck.pop())

    def _reset_round_state(self) -> None:
        for p in self.players:
            p.submitted_card = None
            p.voted_for = None
        self.table = []
        self.clue = ""

    # ------------------------------------------------------------------
    # Phase: STORYTELLER_PICKS
    # ------------------------------------------------------------------

    def storyteller_set_clue(self, player_id: str, card_id: int, clue: str) -> None:
        if self.phase != Phase.STORYTELLER_PICKS:
            raise ValueError("Not time to pick a clue")
        if player_id != self.storyteller.id:
            raise ValueError("You are not the storyteller")
        clue = clue.strip()
        if not clue:
            raise ValueError("Clue cannot be empty")
        card = self._take_card_from_hand(player_id, card_id)
        self.clue = clue
        self.storyteller.submitted_card = card
        self.table.append({"card": card, "owner_id": player_id})
        self.phase = Phase.OTHERS_SUBMIT

    # ------------------------------------------------------------------
    # Phase: OTHERS_SUBMIT
    # ------------------------------------------------------------------

    def player_submit_card(self, player_id: str, card_id: int) -> None:
        if self.phase != Phase.OTHERS_SUBMIT:
            raise ValueError("Not time to submit cards")
        if player_id == self.storyteller.id:
            raise ValueError("Storyteller already submitted")
        player = self._get_or_raise(player_id)
        if player.submitted_card is not None:
            raise ValueError("Already submitted a card")
        card = self._take_card_from_hand(player_id, card_id)
        player.submitted_card = card
        self.table.append({"card": card, "owner_id": player_id})
        # Advance when all non-storytellers have submitted
        non_storytellers = [p for p in self.players if p.id != self.storyteller.id]
        if all(p.submitted_card is not None for p in non_storytellers):
            random.shuffle(self.table)
            self.phase = Phase.VOTING

    # ------------------------------------------------------------------
    # Phase: VOTING
    # ------------------------------------------------------------------

    def player_vote(self, player_id: str, card_id: int) -> None:
        if self.phase != Phase.VOTING:
            raise ValueError("Not time to vote")
        if player_id == self.storyteller.id:
            raise ValueError("Storyteller cannot vote")
        player = self._get_or_raise(player_id)
        if player.voted_for is not None:
            raise ValueError("Already voted")
        # Must vote for a card that is on the table
        table_ids = [t["card"]["id"] for t in self.table]
        if card_id not in table_ids:
            raise ValueError("Card not on the table")
        # Cannot vote for own card
        own_card = player.submitted_card
        if own_card and card_id == own_card["id"]:
            raise ValueError("Cannot vote for your own card")
        player.voted_for = card_id
        # Advance when all non-storytellers have voted
        non_storytellers = [p for p in self.players if p.id != self.storyteller.id]
        if all(p.voted_for is not None for p in non_storytellers):
            self._resolve_round()

    # ------------------------------------------------------------------
    # Scoring
    # ------------------------------------------------------------------

    def _resolve_round(self) -> None:
        storyteller_card_id = self.storyteller.submitted_card["id"]
        non_storytellers = [p for p in self.players if p.id != self.storyteller.id]

        correct_voters = [p for p in non_storytellers if p.voted_for == storyteller_card_id]
        all_correct = len(correct_voters) == len(non_storytellers)
        none_correct = len(correct_voters) == 0

        breakdown = {}

        # Storyteller scoring
        if all_correct or none_correct:
            breakdown[self.storyteller.id] = 0
        else:
            self.storyteller.score += 3
            breakdown[self.storyteller.id] = 3

        # Other players
        for p in non_storytellers:
            pts = 0
            if p.voted_for == storyteller_card_id:
                pts += 2  # correct guess
            # +1 for each vote their card received
            votes_received = sum(
                1 for other in non_storytellers
                if other.voted_for == p.submitted_card["id"]
            )
            pts += votes_received
            p.score += pts
            breakdown[p.id] = pts

        self.last_round_scores = breakdown
        self.phase = Phase.ROUND_END

    # ------------------------------------------------------------------
    # Advance to next round or end game
    # ------------------------------------------------------------------

    def advance(self) -> None:
        """Called after client acknowledges ROUND_END."""
        if self.phase != Phase.ROUND_END:
            raise ValueError("Not at round end")
        if self.current_round >= self.total_rounds:
            self.phase = Phase.GAME_OVER
            return
        self.current_round += 1
        self.storyteller_index = (self.storyteller_index + 1) % len(self.players)
        self._reset_round_state()
        self._deal_hands()
        self.phase = Phase.STORYTELLER_PICKS

    # ------------------------------------------------------------------
    # Serialisation — used to broadcast state to all clients
    # ------------------------------------------------------------------

    def public_state(self) -> dict:
        """Everything a client needs to render the current game state.
        Hand contents are intentionally omitted — each player's hand is
        sent individually via private_state().
        """
        return {
            "code": self.code,
            "phase": self.phase,
            "current_round": self.current_round,
            "total_rounds": self.total_rounds,
            "players": [p.to_public() for p in self.players],
            "storyteller_id": self.storyteller.id if self.players else None,
            "clue": self.clue,
            "table": self._table_for_broadcast(),
            "last_round_scores": self.last_round_scores,
            "host_id": self.host_id,
        }

    def _table_for_broadcast(self) -> list[dict]:
        """During VOTING/ROUND_END reveal cards. Before that, just counts."""
        if self.phase in (Phase.VOTING, Phase.ROUND_END, Phase.GAME_OVER):
            return [
                {
                    "card": t["card"],
                    # reveal owner only at round end
                    "owner_id": t["owner_id"] if self.phase == Phase.ROUND_END else None,
                    "votes": [
                        p.id for p in self.players if p.voted_for == t["card"]["id"]
                    ] if self.phase == Phase.ROUND_END else [],
                }
                for t in self.table
            ]
        return []

    def private_state(self, player_id: str) -> dict:
        """Player's own hand — sent only to that player."""
        player = self.get_player(player_id)
        if not player:
            return {"hand": []}
        submitted_id = player.submitted_card["id"] if player.submitted_card else None
        return {
            "hand": player.hand,
            "submitted_card_id": submitted_id,
            "voted_for": player.voted_for,
        }

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _take_card_from_hand(self, player_id: str, card_id: int) -> dict:
        player = self._get_or_raise(player_id)
        for i, card in enumerate(player.hand):
            if card["id"] == card_id:
                return player.hand.pop(i)
        raise ValueError("Card not in hand")

    def _get_or_raise(self, player_id: str) -> Player:
        player = self.get_player(player_id)
        if not player:
            raise ValueError("Player not found")
        return player
