import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Resolve __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/**
 * In-memory state
 */
let lobbyUsernames = new Set();
let lobbyStartTimeMs = computeNextRaceStartTimeMs();
let raceInProgress = false;
let currentRace = null; // { participants: string[], positions: Map<string, number>, startTimeMs, finishOrder: string[] }
// Track visitors who already joined this lobby (visitorId -> username)
let lobbyJoinsByVisitor = new Map();

/**
 * Minimal cookie parsing and visitor identification
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers?.cookie || '');
  let visitorId = cookies['visitorId'];
  if (!visitorId) {
    visitorId = randomUUID();
    const cookie = `visitorId=${encodeURIComponent(visitorId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
    res.setHeader('Set-Cookie', cookie);
  }
  req.visitorId = visitorId;
  next();
});

/**
 * SSE clients
 */
const sseClients = new Set(); // each item is res

/** Utility: compute next 1-minute wall-clock boundary in ms */
function computeNextRaceStartTimeMs() {
  const now = new Date();
  const nextDate = new Date(now);
  // Always schedule to the next minute boundary
  nextDate.setUTCMinutes(now.getUTCMinutes() + 1, 0, 0);
  return nextDate.getTime();
}

/** Utility: broadcast JSON via SSE */
function broadcast(event, data) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

/** Send current snapshot to a single client */
function sendSnapshot(res, visitorId) {
  const nowMs = Date.now();
  if (!raceInProgress) {
    res.write(`event: lobby_update\n`);
    res.write(`data: ${JSON.stringify({
      startTimeMs: lobbyStartTimeMs,
      nowMs,
      users: Array.from(lobbyUsernames).sort((a, b) => a.localeCompare(b)),
      youJoined: Boolean(visitorId && lobbyJoinsByVisitor.has(visitorId))
    })}\n\n`);
  } else {
    const positionsObj = {};
    for (const [name, pos] of currentRace.positions.entries()) {
      positionsObj[name] = pos;
    }
    res.write(`event: race_update\n`);
    res.write(`data: ${JSON.stringify({
      startTimeMs: currentRace.startTimeMs,
      nowMs,
      positions: positionsObj,
      finishOrder: currentRace.finishOrder
    })}\n\n`);
  }
}

/** SSE endpoint */
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });

  sendSnapshot(res, req.visitorId);
});

/** Join API */
app.post('/api/join', (req, res) => {
  if (raceInProgress) {
    return res.status(409).json({ error: 'Race in progress. Please join the next race.' });
  }
  const visitorId = req.visitorId;
  if (visitorId && lobbyJoinsByVisitor.has(visitorId)) {
    return res.status(409).json({ error: 'You have already joined this lobby.' });
  }
  const username = String((req.body?.username ?? '')).trim();
  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }
  if (username.length > 24) {
    return res.status(400).json({ error: 'Username must be 24 characters or fewer.' });
  }
  // Case-insensitive duplicate check
  const exists = Array.from(lobbyUsernames).some(u => u.toLowerCase() === username.toLowerCase());
  if (exists) {
    return res.status(409).json({ error: 'Username already joined.' });
  }
  lobbyUsernames.add(username);
  if (visitorId) {
    lobbyJoinsByVisitor.set(visitorId, username);
  }
  broadcast('lobby_update', {
    startTimeMs: lobbyStartTimeMs,
    nowMs: Date.now(),
    users: Array.from(lobbyUsernames).sort((a, b) => a.localeCompare(b))
  });
  return res.json({ ok: true });
});

/** Dev-only: start race now */
app.post('/api/start-now', (req, res) => {
  if (raceInProgress) {
    return res.status(409).json({ error: 'Race already in progress.' });
  }
  // If no users, allow starting anyway
  startRace();
  res.json({ ok: true });
});

// GET fallback for environments that block POST in local testing tools
app.get('/api/start-now', (req, res) => {
  if (raceInProgress) {
    return res.status(409).json({ error: 'Race already in progress.' });
  }
  startRace();
  res.json({ ok: true });
});

/** API to get current state (for debugging) */
app.get('/api/state', (req, res) => {
  res.json({
    raceInProgress,
    lobbyStartTimeMs,
    lobbyUsers: Array.from(lobbyUsernames),
    currentRace: currentRace
      ? {
          startTimeMs: currentRace.startTimeMs,
          participants: currentRace.participants,
          finishOrder: currentRace.finishOrder
        }
      : null
  });
});

/**
 * Race simulation
 * - Distance: 100 units
 * - Ticks: every 500ms
 * - Each tick, each marble advances random 2..8 units until finishes
 */
const TRACK_DISTANCE = 100;
const TICK_MS = 500;

function startRace() {
  raceInProgress = true;
  const participants = Array.from(lobbyUsernames);
  currentRace = {
    participants,
    positions: new Map(participants.map(name => [name, 0])),
    startTimeMs: Date.now(),
    finishOrder: []
  };
  // Clear lobby for next cycle, compute next start
  lobbyUsernames = new Set();
  lobbyJoinsByVisitor = new Map();
  lobbyStartTimeMs = computeNextRaceStartTimeMs();

  broadcast('race_start', { participants, startTimeMs: currentRace.startTimeMs });

  const interval = setInterval(() => {
    const unfinished = participants.filter(name => !currentRace.finishOrder.includes(name));
    for (const name of unfinished) {
      const currentPos = currentRace.positions.get(name) ?? 0;
      const advance = 2 + Math.floor(Math.random() * 7); // 2..8
      const newPos = Math.min(TRACK_DISTANCE, currentPos + advance);
      currentRace.positions.set(name, newPos);
      if (newPos >= TRACK_DISTANCE && !currentRace.finishOrder.includes(name)) {
        currentRace.finishOrder.push(name);
      }
    }

    // Broadcast update
    const positionsObj = {};
    for (const [name, pos] of currentRace.positions.entries()) positionsObj[name] = pos;
    broadcast('race_update', {
      positions: positionsObj,
      finishOrder: currentRace.finishOrder
    });

    // End condition
    if (currentRace.finishOrder.length === participants.length || currentRace.finishOrder.length >= Math.max(1, participants.length)) {
      clearInterval(interval);
      raceInProgress = false;
      broadcast('race_complete', {
        finishOrder: currentRace.finishOrder,
        results: currentRace.finishOrder.map((name, index) => ({ name, place: index + 1 }))
      });
      currentRace = null;
      // After completion, broadcast lobby snapshot for next race
      broadcast('lobby_update', {
        startTimeMs: lobbyStartTimeMs,
        nowMs: Date.now(),
        users: Array.from(lobbyUsernames).sort((a, b) => a.localeCompare(b))
      });
    }
  }, TICK_MS);
}

/** Scheduler loop: check every second for race start */
setInterval(() => {
  if (raceInProgress) return;
  const now = Date.now();
  if (now >= lobbyStartTimeMs) {
    startRace();
  }
}, 1000);

/** Also broadcast lobby tick every 5s so countdown stays fresh */
setInterval(() => {
  if (raceInProgress) return;
  broadcast('lobby_update', {
    startTimeMs: lobbyStartTimeMs,
    nowMs: Date.now(),
    users: Array.from(lobbyUsernames).sort((a, b) => a.localeCompare(b))
  });
}, 5000);

app.listen(PORT, () => {
  console.log(`Marble Royale server running on http://localhost:${PORT}`);
});


