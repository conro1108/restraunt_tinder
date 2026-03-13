# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

"Grub Match" — a mobile-friendly web app for groups to decide where to eat. Users join a session via shared link, submit restaurant suggestions with a pitch, then vote on all suggestions. Results are ranked and shown to everyone.

## Commands

- `npm start` — runs the server on port 3000 (or `PORT` env var)
- No build step — vanilla HTML/CSS/JS served statically

## Architecture

Single Node.js server (`server.js`) using Express + Socket.io. All state is in-memory (no database). Frontend is a single-page app in `public/index.html` with client-side routing via `window.location.pathname`.

**Session flow:** submission → matching → results (phase transitions are host-triggered or automatic when all votes are in).

**Key design decisions:**
- Suggestions are anonymous (not mapped to submitters publicly)
- Individual votes are private; only aggregate counts (👍/😐/🚫) shown in results
- Vetos count as dislikes for scoring but are displayed separately
- Participants tracked via `sessionStorage` for rejoin support
- Socket-to-participant mapping enables per-user state broadcasts (each user sees their own vote progress)
