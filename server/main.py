"""
FastAPI server — WebSocket hub + REST endpoints for room management.

Message protocol (JSON over WebSocket):
  Client → Server:  { "action": "...", ...payload }
  Server → Client:  { "type": "...", ...payload }
"""

from __future__ import annotations
import asyncio
import json
import logging
import random
import string
from typing import Optional

import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from game import Room, Phase, MIN_PLAYERS, MAX_PLAYERS

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

ROUND_END_DELAY = 10  # seconds to show results before auto-advancing

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

# ------------------------------------------------------------------
# In-memory store
# ------------------------------------------------------------------
# rooms: { room_code -> Room }
rooms: dict[str, Room] = {}
# connections: { room_code -> { player_id -> WebSocket } }
connections: dict[str, dict[str, WebSocket]] = {}


# ------------------------------------------------------------------
# Utilities
# ------------------------------------------------------------------

def _make_room_code(length: int = 4) -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase, k=length))
        if code not in rooms:
            return code


async def _broadcast(room_code: str, message: dict) -> None:
    """Send a message to every connected player in the room."""
    sockets = connections.get(room_code, {})
    dead = []
    for pid, ws in sockets.items():
        try:
            await ws.send_text(json.dumps(message))
        except Exception:
            dead.append(pid)
    for pid in dead:
        sockets.pop(pid, None)


async def _send(ws: WebSocket, message: dict) -> None:
    await ws.send_text(json.dumps(message))


async def _auto_advance(room_code: str) -> None:
    """Wait, then auto-advance to the next round (or game over)."""
    await asyncio.sleep(ROUND_END_DELAY)
    room = rooms.get(room_code)
    if not room or room.phase != Phase.ROUND_END:
        return  # already advanced or room gone
    room.advance()
    await _push_state(room_code)


async def _push_state(room_code: str) -> None:
    """Broadcast public state + each player's private hand."""
    room = rooms.get(room_code)
    if not room:
        return
    public = room.public_state()
    public["round_end_delay"] = ROUND_END_DELAY
    await _broadcast(room_code, {"type": "state", "state": public})
    # Send each player their private hand
    for pid, ws in connections.get(room_code, {}).items():
        private = room.private_state(pid)
        try:
            await ws.send_text(json.dumps({"type": "hand", **private}))
        except Exception:
            pass


# ------------------------------------------------------------------
# REST — room creation
# ------------------------------------------------------------------

@app.post("/api/rooms")
async def create_room(body: dict) -> dict:
    total_rounds = int(body.get("total_rounds", 5))
    total_rounds = max(1, min(total_rounds, 20))
    code = _make_room_code()
    rooms[code] = Room(code=code, total_rounds=total_rounds)
    connections[code] = {}
    logger.info("Room created: %s", code)
    return {"code": code}


# ------------------------------------------------------------------
# WebSocket — main game channel
# ------------------------------------------------------------------

@app.websocket("/ws/{room_code}/{player_id}")
async def websocket_endpoint(ws: WebSocket, room_code: str, player_id: str):
    room = rooms.get(room_code)
    if not room:
        await ws.accept()
        await _send(ws, {"type": "error", "message": "Room not found"})
        await ws.close()
        return

    await ws.accept()
    connections.setdefault(room_code, {})[player_id] = ws
    logger.info("Player %s connected to room %s", player_id, room_code)

    try:
        # Send current state immediately on connect
        await _send(ws, {"type": "state", "state": room.public_state()})
        await _send(ws, {"type": "hand", **room.private_state(player_id)})

        async for raw in ws.iter_text():
            try:
                msg = json.loads(raw)
                await _handle(ws, room_code, player_id, msg)
            except json.JSONDecodeError:
                await _send(ws, {"type": "error", "message": "Invalid JSON"})
            except ValueError as e:
                await _send(ws, {"type": "error", "message": str(e)})
            except Exception as e:
                logger.exception("Unexpected error")
                await _send(ws, {"type": "error", "message": "Server error"})

    except WebSocketDisconnect:
        logger.info("Player %s disconnected from room %s", player_id, room_code)
    finally:
        connections.get(room_code, {}).pop(player_id, None)
        # Don't remove from game — they may reconnect


# ------------------------------------------------------------------
# Action dispatcher
# ------------------------------------------------------------------

async def _handle(ws: WebSocket, room_code: str, player_id: str, msg: dict) -> None:
    action = msg.get("action")
    room = rooms[room_code]

    if action == "join":
        name = str(msg.get("name", "")).strip()[:20]
        if not name:
            raise ValueError("Name is required")
        existing = room.get_player(player_id)
        if existing:
            # Reconnect — just re-sync state
            await _push_state(room_code)
            return
        player = room.add_player(player_id, name)
        if not room.host_id:
            room.host_id = player_id
        await _push_state(room_code)

    elif action == "start_game":
        if player_id != room.host_id:
            raise ValueError("Only the host can start the game")
        room.start_game()
        await _push_state(room_code)

    elif action == "set_clue":
        card_id = int(msg["card_id"])
        clue = str(msg.get("clue", "")).strip()
        room.storyteller_set_clue(player_id, card_id, clue)
        await _push_state(room_code)

    elif action == "submit_card":
        card_id = int(msg["card_id"])
        room.player_submit_card(player_id, card_id)
        await _push_state(room_code)

    elif action == "vote":
        card_id = int(msg["card_id"])
        room.player_vote(player_id, card_id)
        await _push_state(room_code)
        # Auto-advance after round end
        if room.phase == Phase.ROUND_END:
            asyncio.create_task(_auto_advance(room_code))

    else:
        raise ValueError(f"Unknown action: {action}")


# ------------------------------------------------------------------
# Serve static frontend
# ------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/game")
async def game():
    return FileResponse(STATIC_DIR / "game.html")
