/* ================================================================
   TeaDixit — Game Client
   All WebSocket communication and UI rendering lives here.
   ================================================================ */

// ------------------------------------------------------------------
// Session
// ------------------------------------------------------------------
const PLAYER_ID  = sessionStorage.getItem('playerId');
const PLAYER_NAME = sessionStorage.getItem('playerName');
const ROOM_CODE  = sessionStorage.getItem('roomCode');

if (!PLAYER_ID || !PLAYER_NAME || !ROOM_CODE) {
  window.location.href = '/';
}

// ------------------------------------------------------------------
// State
// ------------------------------------------------------------------
let state = null;   // public game state
let hand  = [];     // this player's hand
let submittedCardId = null;
let votedFor = null;
let pickedCardId = null;  // card selected in hand before confirming
let roundEndCountdown = null;  // interval id for round-end countdown
let roundEndSecondsLeft = 0;
let roundEndForRound = -1;    // which round the countdown was started for
let handCollapsed = false;
let lastPhase = null;

// ------------------------------------------------------------------
// WebSocket
// ------------------------------------------------------------------
const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsUrl = `${wsProto}://${location.host}/ws/${ROOM_CODE}/${PLAYER_ID}`;
let ws;

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    send({ action: 'join', name: PLAYER_NAME });
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') {
      state = msg.state;
      render();
    } else if (msg.type === 'hand') {
      hand = msg.hand;
      submittedCardId = msg.submitted_card_id;
      votedFor = msg.voted_for;
      render();
    } else if (msg.type === 'error') {
      showToast(msg.message);
    }
  };

  ws.onclose = () => {
    setTimeout(connect, 2000); // auto-reconnect
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// ------------------------------------------------------------------
// Render dispatcher
// ------------------------------------------------------------------
function render() {
  if (!state) return;
  updateHeader();
  const main    = document.getElementById('main-content');
  const sidebar = document.getElementById('game-sidebar');
  const footer  = document.getElementById('footer-actions');
  const hint    = document.getElementById('footer-hint');

  // Clear round-end countdown when leaving that phase
  if (state.phase !== 'round_end' && roundEndCountdown) {
    clearInterval(roundEndCountdown);
    roundEndCountdown = null;
  }

  // Auto-collapse hand during voting, auto-expand on new round
  if (state.phase !== lastPhase) {
    if (state.phase === 'voting') {
      handCollapsed = true;
    } else if (state.phase === 'storyteller_picks' && lastPhase !== null) {
      handCollapsed = false;
    }
    lastPhase = state.phase;
  }

  switch (state.phase) {
    case 'lobby':             renderLobby(main, sidebar, footer, hint);             break;
    case 'storyteller_picks': renderStorytellerPicks(main, sidebar, footer, hint);  break;
    case 'others_submit':     renderOthersSubmit(main, sidebar, footer, hint);      break;
    case 'voting':            renderVoting(main, sidebar, footer, hint);            break;
    case 'round_end':         renderRoundEnd(main, sidebar, footer, hint);          break;
    case 'game_over':         renderGameOver(main, sidebar, footer, hint);          break;
  }

  renderPersistentHand();
}

function renderPersistentHand() {
  const strip = document.getElementById('hand-strip');
  if (!strip) return;
  const showHand = state.phase !== 'lobby' && state.phase !== 'game_over' && hand.length > 0;
  if (!showHand) {
    strip.innerHTML = '<span class="hand-empty">No cards in hand</span>';
    return;
  }

  // Determine if cards are pickable in this phase
  const amStoryteller = state.storyteller_id === PLAYER_ID;
  const pickable =
    (state.phase === 'storyteller_picks' && amStoryteller) ||
    (state.phase === 'others_submit' && !amStoryteller && submittedCardId === null);

  const cards = hand.map(card => {
    const isPicked = card.id === pickedCardId;
    const cls = pickable ? `hand-card pickable ${isPicked ? 'picked' : ''}` : 'hand-card';
    return `<div class="${cls}" data-card-id="${card.id}">
      ${renderCardVisual(card)}
    </div>`;
  });

  strip.innerHTML = `
    <div class="hand-section">
      <div class="hand-title">
        Your hand (${hand.length})
        <button class="hand-toggle-btn" onclick="toggleHand()">${handCollapsed ? '&#x25B2; Show' : '&#x25BC; Hide'}</button>
      </div>
      ${handCollapsed ? '' : `<div class="hand-cards">${cards.join('')}</div>`}
    </div>
  `;

  if (pickable) {
    const isStorytellerPhase = state.phase === 'storyteller_picks';
    strip.querySelectorAll('.hand-card.pickable').forEach(el => {
      el.addEventListener('click', () => {
        pickedCardId = parseInt(el.dataset.cardId);
        strip.querySelectorAll('.hand-card').forEach(c => c.classList.remove('picked'));
        el.classList.add('picked');

        if (isStorytellerPhase) {
          const form = document.getElementById('clue-form');
          const prompt = document.getElementById('pick-prompt');
          if (form) form.style.display = '';
          if (prompt) prompt.style.display = 'none';
        } else {
          updateSubmitButton();
        }
      });
    });
  }
}

function updateHeader() {
  const badge = document.getElementById('round-badge');
  const phaseLabel = document.getElementById('phase-label');
  const scoreboard = document.getElementById('scoreboard');

  if (state.phase === 'lobby') {
    badge.style.display = 'none';
  } else {
    badge.style.display = '';
    badge.textContent = `Round ${state.current_round} / ${state.total_rounds}`;
  }

  const phaseNames = {
    lobby: '',
    storyteller_picks: 'Storyteller picks',
    others_submit: 'Submit a card',
    voting: 'Vote!',
    round_end: 'Round results',
    game_over: 'Game over',
  };
  phaseLabel.textContent = phaseNames[state.phase] || '';

  scoreboard.innerHTML = state.players.map(p => {
    const isStoryteller = state.storyteller_id === p.id && state.phase !== 'lobby';
    return `<div class="score-chip ${isStoryteller ? 'is-storyteller' : ''}">
      ${escHtml(p.name)} <span class="score-val">${p.score}</span>
    </div>`;
  }).join('');
}

// ------------------------------------------------------------------
// LOBBY
// ------------------------------------------------------------------
function renderLobby(main, sidebar, footer, hint) {
  const isHost = state.host_id === PLAYER_ID;
  const canStart = state.players.length >= 3;

  main.innerHTML = `
    <div class="waiting-room">
      <h2>Waiting for players…</h2>
      <div class="room-code-display">${escHtml(state.code)}</div>
      <p>Share this code with friends · ${state.players.length}/10 players</p>
      <div class="player-chips">
        ${state.players.map(p => `
          <div class="player-chip ${p.id === state.host_id ? 'host' : ''}">
            ${escHtml(p.name)}${p.id === state.host_id ? ' ★' : ''}
          </div>
        `).join('')}
      </div>
      ${isHost && !canStart ? '<p style="color:var(--accent)">Need at least 3 players to start</p>' : ''}
    </div>
  `;

  sidebar.innerHTML = `
    <h3>Players (${state.players.length}/10)</h3>
    <div class="waiting-list">
      ${state.players.map(p => `
        <div class="waiting-player">
          <div class="dot"></div> ${escHtml(p.name)}
          ${p.id === state.host_id ? ' ★' : ''}
        </div>
      `).join('')}
    </div>
  `;

  hint.textContent = isHost ? 'You are the host' : `Waiting for host (${ownerName()}) to start…`;
  footer.innerHTML = `
    <button class="btn btn-secondary" onclick="leaveRoom()">Leave Room</button>
    ${isHost ? `<button class="btn btn-primary" onclick="startGame()" ${canStart ? '' : 'disabled'}>Start Game</button>` : ''}
  `;
}

// ------------------------------------------------------------------
// STORYTELLER PICKS
// ------------------------------------------------------------------
function renderStorytellerPicks(main, sidebar, footer, hint) {
  const amStoryteller = state.storyteller_id === PLAYER_ID;
  const storytellerName = playerName(state.storyteller_id);

  if (amStoryteller) {
    hint.textContent = 'Pick a card from your hand, then enter your clue.';
    main.innerHTML = '';
    footer.innerHTML = '';
    sidebar.innerHTML = `
      <div class="clue-form" id="clue-form" style="display:none">
        <h3>Your clue</h3>
        <p>What does your card remind you of?</p>
        <input id="clue-input" class="input" type="text" maxlength="120" placeholder="Enter your clue…" />
        <button class="btn btn-primary" onclick="submitClue()">Submit Clue</button>
      </div>
      <div id="pick-prompt">
        <h3>Your hand</h3>
        <p>Click a card below to select it, then write your clue.</p>
      </div>
    `;
  } else {
    hint.textContent = `${storytellerName} is thinking of a clue…`;
    main.innerHTML = '';
    sidebar.innerHTML = `
      <h3>Players</h3>
      <div class="waiting-list">
        ${state.players.map(p => `
          <div class="waiting-player ${p.id === state.storyteller_id ? 'done' : ''}">
            <div class="dot"></div> ${escHtml(p.name)}
            ${p.id === state.storyteller_id ? ' (storyteller)' : ''}
          </div>
        `).join('')}
      </div>
    `;
    footer.innerHTML = '';
  }
}

// ------------------------------------------------------------------
// OTHERS SUBMIT
// ------------------------------------------------------------------
function renderOthersSubmit(main, sidebar, footer, hint) {
  const amStoryteller = state.storyteller_id === PLAYER_ID;
  const alreadySubmitted = submittedCardId !== null;

  sidebar.innerHTML = `
    <h3>Waiting for…</h3>
    ${renderWaitingList()}
  `;

  if (amStoryteller) {
    hint.textContent = 'Others are choosing their cards…';
    main.innerHTML = `
      <div class="clue-box">
        <div class="clue-label">Your clue</div>
        <div class="clue-text">${escHtml(state.clue)}</div>
      </div>
    `;
    footer.innerHTML = '';
  } else if (alreadySubmitted) {
    hint.textContent = 'Card submitted! Waiting for others…';
    main.innerHTML = `
      <div class="clue-box">
        <div class="clue-label">Clue</div>
        <div class="clue-text">${escHtml(state.clue)}</div>
      </div>
    `;
    footer.innerHTML = '';
  } else {
    hint.textContent = 'Pick a card that fits the clue.';
    main.innerHTML = `
      <div class="clue-box">
        <div class="clue-label">Clue</div>
        <div class="clue-text">${escHtml(state.clue)}</div>
      </div>
    `;
    footer.innerHTML = `<button class="btn btn-primary" id="btn-submit-card" onclick="submitCard()" disabled>Submit Card</button>`;
    updateSubmitButton();
  }
}

// ------------------------------------------------------------------
// VOTING
// ------------------------------------------------------------------
function renderVoting(main, sidebar, footer, hint) {
  const amStoryteller = state.storyteller_id === PLAYER_ID;
  const alreadyVoted = votedFor !== null;

  sidebar.innerHTML = `
    <h3>Waiting for votes…</h3>
    ${renderWaitingList()}
  `;

  if (amStoryteller) {
    hint.textContent = 'Players are voting — no peeking!';
    main.innerHTML = `
      <div class="clue-box">
        <div class="clue-label">Your clue</div>
        <div class="clue-text">${escHtml(state.clue)}</div>
      </div>
      <div class="table-title">Cards on the table</div>
      <div class="table-cards">${renderTableCards(false)}</div>
    `;
    footer.innerHTML = '';
  } else if (alreadyVoted) {
    hint.textContent = 'Vote cast! Waiting for others…';
    main.innerHTML = `
      <div class="clue-box">
        <div class="clue-label">Clue</div>
        <div class="clue-text">${escHtml(state.clue)}</div>
      </div>
      <div class="table-title">Cards on the table</div>
      <div class="table-cards">${renderTableCards(false, votedFor)}</div>
    `;
    footer.innerHTML = '';
  } else {
    hint.textContent = 'Click a card to vote for it.';
    main.innerHTML = `
      <div class="clue-box">
        <div class="clue-label">Clue</div>
        <div class="clue-text">${escHtml(state.clue)}</div>
      </div>
      <div class="table-title">Cards on the table — click to vote</div>
      <div class="table-cards" id="table-cards-container">${renderTableCards(true)}</div>
    `;
    footer.innerHTML = `<button class="btn btn-primary" id="btn-vote" onclick="castVote()" disabled>Cast Vote</button>`;
    attachTableVoteListeners();
  }
}

// ------------------------------------------------------------------
// ROUND END
// ------------------------------------------------------------------
function renderRoundEnd(main, sidebar, footer, hint) {
  // Start countdown if not already running, or if this is a new round
  if (!roundEndCountdown || roundEndForRound !== state.current_round) {
    if (roundEndCountdown) clearInterval(roundEndCountdown);
    roundEndForRound = state.current_round;
    roundEndSecondsLeft = state.round_end_delay || 10;
    roundEndCountdown = setInterval(() => {
      roundEndSecondsLeft--;
      const el = document.getElementById('countdown-text');
      if (el) el.textContent = `Next round in ${roundEndSecondsLeft}s…`;
      if (roundEndSecondsLeft <= 0) {
        clearInterval(roundEndCountdown);
        roundEndCountdown = null;
      }
    }, 1000);
  }

  hint.textContent = 'Round over!';

  main.innerHTML = `
    <div class="clue-box">
      <div class="clue-label">Clue was</div>
      <div class="clue-text">${escHtml(state.clue)}</div>
    </div>
    <div class="table-title">Revealed cards</div>
    <div class="table-cards">${renderTableCardsRevealed()}</div>
  `;

  sidebar.innerHTML = `
    <h3>Points this round</h3>
    <div class="results-panel">
      ${state.players.map(p => {
        const pts = state.last_round_scores[p.id] ?? 0;
        return `<div class="results-row">
          <span>${escHtml(p.name)}</span>
          <span class="pts">+${pts}</span>
        </div>`;
      }).join('')}
    </div>
    <hr style="border-color:var(--surface2)" />
    <h3>Total scores</h3>
    <div class="results-panel">
      ${[...state.players].sort((a,b) => b.score - a.score).map(p => `
        <div class="results-row">
          <span>${escHtml(p.name)}</span>
          <span class="pts">${p.score}</span>
        </div>
      `).join('')}
    </div>
  `;

  footer.innerHTML = `<span id="countdown-text" style="color:var(--text-muted)">Next round in ${roundEndSecondsLeft}s…</span>`;
}

// ------------------------------------------------------------------
// GAME OVER
// ------------------------------------------------------------------
function renderGameOver(main, sidebar, footer, hint) {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  const winner = sorted[0];

  hint.textContent = 'Thanks for playing!';
  main.innerHTML = `
    <div class="waiting-room">
      <h2>Game Over!</h2>
      <p style="font-size:1.5rem;color:var(--accent2);font-weight:700;">🏆 ${escHtml(winner.name)} wins!</p>
      <div class="results-panel card" style="width:100%;max-width:380px">
        ${sorted.map((p, i) => `
          <div class="results-row">
            <span>${i + 1}. ${escHtml(p.name)}</span>
            <span class="pts">${p.score} pts</span>
          </div>
        `).join('')}
      </div>
      <button class="btn btn-secondary" onclick="window.location.href='/'">Back to Lobby</button>
    </div>
  `;

  sidebar.innerHTML = `
    <h3>Final Standings</h3>
    <div class="results-panel">
      ${sorted.map((p, i) => `
        <div class="results-row">
          <span>${i + 1}. ${escHtml(p.name)}</span>
          <span class="pts">${p.score} pts</span>
        </div>
      `).join('')}
    </div>
  `;

  footer.innerHTML = '';
}

function updateSubmitButton() {
  const btn = document.getElementById('btn-submit-card');
  if (btn) btn.disabled = pickedCardId === null;
}

// ------------------------------------------------------------------
// Table card rendering
// ------------------------------------------------------------------
function renderTableCards(clickable, highlightId = null) {
  return state.table.map(t => {
    const card = t.card;
    const isHighlighted = card.id === highlightId;
    return `<div class="table-card ${clickable ? 'clickable' : ''} ${isHighlighted ? 'selected-vote' : ''}" data-card-id="${card.id}">
      ${renderCardVisual(card)}
    </div>`;
  }).join('');
}

function renderTableCardsRevealed() {
  if (!state.table || !state.table.length) return '<p style="color:var(--text-muted)">No cards.</p>';
  return state.table.map(t => {
    const card = t.card;
    const ownerId = t.owner_id;
    const votes = t.votes || [];
    const isStoryteller = ownerId === state.storyteller_id;
    const ownerNameStr = playerName(ownerId);
    const voterNames = votes.map(vid => playerName(vid)).join(', ');

    return `<div class="table-card">
      ${renderCardVisual(card, votes.length)}
      <div class="owner-badge ${isStoryteller ? 'storyteller-card' : ''}">
        ${isStoryteller ? '★ ' : ''}${escHtml(ownerNameStr)}
        ${votes.length ? `<br><small>${escHtml(voterNames)} voted</small>` : ''}
      </div>
    </div>`;
  }).join('');
}

function attachTableVoteListeners() {
  let selectedId = null;
  document.querySelectorAll('.table-card.clickable').forEach(el => {
    el.addEventListener('click', () => {
      selectedId = parseInt(el.dataset.cardId);
      document.querySelectorAll('.table-card').forEach(c => c.classList.remove('selected-vote'));
      el.classList.add('selected-vote');
      const btn = document.getElementById('btn-vote');
      if (btn) btn.disabled = false;
      // Store selection
      el.closest('#table-cards-container') && (window._pendingVote = selectedId);
    });
  });
}

function renderWaitingList() {
  // Show which non-storytellers have submitted/voted based on phase
  const isSubmitPhase = state.phase === 'others_submit';
  const isVotePhase = state.phase === 'voting';
  return `<div class="waiting-list">
    ${state.players.filter(p => p.id !== state.storyteller_id).map(p => {
      const done = isSubmitPhase ? p.has_submitted : isVotePhase ? p.has_voted : false;
      return `<div class="waiting-player ${done ? 'done' : 'pending'}">
        <div class="dot"></div> ${escHtml(p.name)}
        <span class="status-label">${done ? 'Done' : 'Waiting…'}</span>
      </div>`;
    }).join('')}
  </div>`;
}

// ------------------------------------------------------------------
// Card visual (placeholder — colored rectangle with label)
// ------------------------------------------------------------------
function renderCardVisual(card, voteCount) {
  const bg = card.image
    ? `background-image:url('${card.image}');background-size:cover;background-position:center`
    : `background:${card.color}`;
  return `<div class="dixit-card" style="${bg}">
    ${!card.image ? `<span>${escHtml(card.label)}</span>` : ''}
    ${voteCount !== undefined ? `<span class="card-vote-count">${voteCount} vote${voteCount !== 1 ? 's' : ''}</span>` : ''}
    ${card.image ? `<button class="card-zoom-btn" onclick="event.stopPropagation(); openCardModal('${card.image.replace('/300/400', '/900/1200')}')">&#x1f50d;</button>` : ''}
  </div>`;
}

// ------------------------------------------------------------------
// Actions
// ------------------------------------------------------------------
function openCardModal(imageUrl) {
  const modal = document.getElementById('card-modal');
  const img = document.getElementById('card-modal-img');
  img.src = imageUrl;
  modal.classList.add('open');
}

function closeCardModal() {
  document.getElementById('card-modal').classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCardModal();
});

function toggleHand() {
  handCollapsed = !handCollapsed;
  renderPersistentHand();
}

function startGame() { send({ action: 'start_game' }); }

function leaveRoom() {
  send({ action: 'leave' });
  sessionStorage.clear();
  window.location.href = '/';
}

function submitClue() {
  const clue = document.getElementById('clue-input')?.value.trim();
  if (!clue) { showToast('Enter a clue first'); return; }
  if (pickedCardId === null) { showToast('Pick a card first'); return; }
  send({ action: 'set_clue', card_id: pickedCardId, clue });
  pickedCardId = null;
}

function submitCard() {
  if (pickedCardId === null) { showToast('Pick a card first'); return; }
  send({ action: 'submit_card', card_id: pickedCardId });
  pickedCardId = null;
}

function castVote() {
  const vid = window._pendingVote;
  if (vid === undefined || vid === null) { showToast('Select a card to vote for'); return; }
  send({ action: 'vote', card_id: vid });
  window._pendingVote = null;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function playerName(id) {
  if (!state) return '';
  const p = state.players.find(p => p.id === id);
  return p ? p.name : '?';
}
function ownerName() { return playerName(state.host_id); }

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg, duration = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

// ------------------------------------------------------------------
// Boot
// ------------------------------------------------------------------
connect();
