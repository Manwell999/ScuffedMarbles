const usernameInput = document.getElementById('username');
const joinForm = document.getElementById('joinForm');
const joinMsg = document.getElementById('joinMsg');
const usersEl = document.getElementById('users');
const trackEl = document.getElementById('track');
const finishEl = document.getElementById('finish');
const timerEl = document.getElementById('timer');
const startNowBtn = document.getElementById('startNow');

let latestLobby = { startTimeMs: null, nowMs: Date.now(), users: [] };
let latestRace = null;
let serverTimeOffsetMs = 0; // clientNow - serverNow; used to align countdown with server
const POST_RACE_SHOW_MS = 8000; // keep winner visible for this duration after race ends
let lastRaceCompleteAtMs = 0;
let postRaceClearTimeout = null;

function setJoinDisabled(disabled, message = '') {
  usernameInput.disabled = disabled;
  const btn = joinForm.querySelector('button[type="submit"]');
  if (btn) btn.disabled = disabled;
  joinMsg.textContent = message;
}

joinForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = (usernameInput.value || '').trim();
  if (!username) return;
  try {
    setJoinDisabled(true, 'Joining...');
    const res = await fetch('/api/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to join');
    setJoinDisabled(true, 'Joined!');
    usernameInput.value = '';
  } catch (err) {
    setJoinDisabled(false, err.message);
  }
});

function renderLobby(lobby) {
  usersEl.innerHTML = '';
  for (const u of lobby.users) {
    const li = document.createElement('li');
    li.textContent = u;
    usersEl.appendChild(li);
  }
}

function ensureLanes(participants) {
  const existing = new Set(Array.from(trackEl.children).map(c => c.dataset.name));
  for (const name of participants) {
    if (!existing.has(name)) {
      const lane = document.createElement('div');
      lane.className = 'lane';
      lane.dataset.name = name;
      const label = document.createElement('div');
      label.className = 'name';
      label.textContent = name;
      const bar = document.createElement('div');
      bar.className = 'bar';
      const marble = document.createElement('div');
      marble.className = 'marble';
      bar.appendChild(marble);
      lane.appendChild(label);
      lane.appendChild(bar);
      trackEl.appendChild(lane);
    }
  }
}

function renderRaceUpdate(update) {
  ensureLanes(Object.keys(update.positions));
  for (const [name, pos] of Object.entries(update.positions)) {
    const lane = trackEl.querySelector(`.lane[data-name="${CSS.escape(name)}"]`);
    if (!lane) continue;
    const marble = lane.querySelector('.marble');
    const pct = Math.max(0, Math.min(100, (pos / 100) * 100));
    marble.style.left = `calc(${pct}% - 7px)`;
  }
  finishEl.innerHTML = '';
  for (const name of update.finishOrder || []) {
    const li = document.createElement('li');
    li.textContent = name;
    finishEl.appendChild(li);
  }
}

function updateCountdown(startTimeMs, nowMs) {
  const diff = Math.max(0, startTimeMs - nowMs);
  const mm = Math.floor(diff / 60000);
  const ss = Math.floor((diff % 60000) / 1000);
  timerEl.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// SSE setup
const ev = new EventSource('/events');
ev.addEventListener('lobby_update', (e) => {
  latestRace = null;
  const data = JSON.parse(e.data);
  latestLobby = data;
  // Align local clock with server clock for accurate countdown
  if (typeof data.nowMs === 'number') {
    serverTimeOffsetMs = Date.now() - data.nowMs;
  }
  renderLobby(data);
  // Use server-aligned time for countdown to avoid client clock skew
  updateCountdown(data.startTimeMs, Date.now() - serverTimeOffsetMs);
  // Reset track and finish if not racing and outside the post-race showcase window
  const nowAligned = Date.now() - serverTimeOffsetMs;
  if (!lastRaceCompleteAtMs || (nowAligned - lastRaceCompleteAtMs) >= POST_RACE_SHOW_MS) {
    trackEl.innerHTML = '';
    finishEl.innerHTML = '';
  }
  // Enable/disable join UI based on whether this visitor already joined
  if (data.youJoined) {
    setJoinDisabled(true, 'You have joined this lobby.');
  } else {
    setJoinDisabled(false, '');
  }
});

ev.addEventListener('race_start', (e) => {
  const data = JSON.parse(e.data);
  trackEl.innerHTML = '';
  finishEl.innerHTML = '';
  ensureLanes(data.participants);
});

ev.addEventListener('race_update', (e) => {
  const data = JSON.parse(e.data);
  latestRace = data;
  renderRaceUpdate(data);
});

ev.addEventListener('race_complete', (e) => {
  const data = JSON.parse(e.data);
  renderRaceUpdate({ positions: latestRace?.positions || {}, finishOrder: data.finishOrder });
  // Remember when race completed to delay clearing UI
  lastRaceCompleteAtMs = Date.now() - serverTimeOffsetMs;
  if (postRaceClearTimeout) {
    clearTimeout(postRaceClearTimeout);
    postRaceClearTimeout = null;
  }
  // Failsafe: ensure UI clears after the post-race window even if no further lobby updates arrive
  postRaceClearTimeout = setTimeout(() => {
    const nowAligned = Date.now() - serverTimeOffsetMs;
    if (lastRaceCompleteAtMs && (nowAligned - lastRaceCompleteAtMs) >= POST_RACE_SHOW_MS) {
      trackEl.innerHTML = '';
      finishEl.innerHTML = '';
    }
  }, POST_RACE_SHOW_MS + 100);
});

// Local countdown tick
setInterval(() => {
  if (latestLobby?.startTimeMs) {
    updateCountdown(latestLobby.startTimeMs, Date.now() - serverTimeOffsetMs);
  }
}, 1000);

// Dev-only start button visibility
const urlParams = new URLSearchParams(location.search);
const host = location.hostname || '';
const devMode = (
  urlParams.get('dev') === '1' ||
  host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' ||
  /^192\.168\./.test(host) || /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
);
if (startNowBtn && devMode) {
  startNowBtn.style.display = 'inline-block';
  startNowBtn.addEventListener('click', async () => {
    startNowBtn.disabled = true;
    try {
      let res = await fetch('/api/start-now?dev=1', { method: 'POST' });
      let text = await res.text();
      if (!res.ok) {
        // Try GET fallback
        res = await fetch('/api/start-now?dev=1', { method: 'GET' });
        text = await res.text();
      }
      if (!res.ok) {
        let msg = 'Failed to start';
        try { const j = JSON.parse(text); if (j && j.error) msg = j.error; } catch {}
        throw new Error(msg);
      }
    } catch (err) {
      joinMsg.textContent = err.message;
    } finally {
      startNowBtn.disabled = false;
    }
  });
}


