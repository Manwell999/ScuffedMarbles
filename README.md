Marble Racing Game

A minimal Node.js + Express marble racing game. Users join the next race with a username. Races start every 1 minute (on the next minute UTC boundary). Live updates stream via Server-Sent Events.

Features
- Join the next race with a unique username
- Lobby countdown to the next 1-minute start
- Automatic race simulation with positions and finish order
- Real-time updates over SSE

Requirements
- Node.js 18+

Install & Run
```bash
npm install
npm run start
# Open http://localhost:3000
```

How it works
- The server keeps a lobby of usernames for the next race.
- A scheduler checks every second; when the lobby start time is reached, the race starts.
- Races simulate progress every 500ms until all finish; after a race, the next start time jumps to the next 1-minute boundary and the lobby resets.

Endpoints
- POST `/api/join` { username }
- GET `/events` Server-Sent Events stream (lobby_update, race_start, race_update, race_complete)
- Static UI at `/`

Notes
- State is in-memory and resets on server restart.
- Username max length is 24, duplicate names in a lobby are blocked (case-insensitive).


