"""
Placeholder card deck.
Each card is a dict: { "id": int, "color": str, "label": str }
Designed so a real image URL can be swapped in later (just add an "image" key).
"""

import random

# 84 cards like the real Dixit deck
DECK_SIZE = 1000

PALETTE = [
    "#e07b54", "#e0a854", "#e0d454", "#7be07b",
    "#54b4e0", "#7b54e0", "#e054b4", "#54e0a8",
    "#c0392b", "#2980b9", "#27ae60", "#8e44ad",
    "#f39c12", "#16a085", "#d35400", "#2c3e50",
]


def build_deck() -> list[dict]:
    cards = []
    for i in range(DECK_SIZE):
        color = PALETTE[i % len(PALETTE)]
        cards.append({
            "id": i,
            "color": color,
            "label": f"Card {i + 1}",
            "image": f"https://picsum.photos/300/400?random={i}",
            # "image": f"https://image.pollinations.ai/prompt/surreal%20dreamlike%20dixit%20board%20game%20illustration%20fantasy%20art?width=300&height=400&seed={i}&nologo=true",
        })
    return cards


def shuffled_deck() -> list[dict]:
    deck = build_deck()
    random.shuffle(deck)
    return deck
