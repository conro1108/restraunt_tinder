# Grub Match

A mobile-friendly web app for groups to decide where to eat. Users join a session via shared link, submit restaurant suggestions with a pitch, then vote on all suggestions. Results are ranked and shown to everyone.

## How It Works

1. **Host creates a session** and shares the invite link
2. **Everyone joins** and adds restaurant suggestions with optional pitches
3. **Host starts voting** - each suggestion is shown as a card to vote on (like/meh/veto)
4. **Results appear** automatically when all votes are in, or when the host ends voting early

## Quick Start

```bash
npm install
npm start        # http://localhost:3000
```

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start the server (port 3000 or `PORT` env var) |
| `npm test` | Run the test suite (52 tests) |

## Architecture

Single Node.js server (`server.js`) using Express + Socket.io. Frontend is vanilla HTML/CSS/JS in `public/`. All state is in-memory (no database).

**Key design decisions:**
- Suggestions are anonymous
- Individual votes are private; only aggregate counts shown in results
- Participants tracked via `sessionStorage` for rejoin support
- Auto-rejoin on Socket.io reconnection (handles mobile network drops)
- Per-user state broadcasts (each user sees their own vote progress)

**Limits:** 50 participants per session, 50 suggestions per session, sessions expire after 2 hours of inactivity.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |

## Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Home page |
| `GET /s/:id` | Join session via invite link |
| `GET /health` | Health check (returns 200) |

## Deployment

Deployed on Render. No build step needed - just `npm start`.
