# DESIGN: Grub Match Reliability Fixes

## Problem Statement

During real-world social use, the joining and suggestion-adding phase is unreliable:
- Items added by one person show up for some but not others
- Adding suggestions sometimes doesn't "go through"
- Participant list doesn't stay consistently up to date

## Root Cause Analysis

### Bug 1: No client-side reconnection handling (PRIMARY)

Socket.io auto-reconnects on network interruptions (very common on mobile). When it reconnects, the server creates a **brand new** `connection` handler with `currentSession = null` and `currentParticipantId = null`. The client never re-emits `rejoin` after reconnect, so:

- The server doesn't know who this socket belongs to
- The socket isn't in any room or socketMap
- The user stops receiving state broadcasts
- Any actions (suggest, vote) silently fail because `currentSession` is null

**This is the #1 cause of the reported issues.** Mobile networks frequently drop WebSocket connections for a few seconds.

### Bug 2: broadcastState misses unregistered sockets

`broadcastState()` iterates `session.participants` and looks up sockets via `socketMap`. If a participant's socket isn't registered (due to reconnection, race condition, or the socket dying), they silently miss the update. There's no fallback or retry.

### Bug 3: Client ignores errors from suggest callback

```js
socket.emit('suggest', { name, pitch }, () => {
  document.getElementById('sugName').value = '';  // clears form regardless of error
});
```

The callback ignores the response object, so if `suggest` returns `{ error: '...' }`, the form clears and the user thinks it worked. The suggestion never appears.

### Bug 4: Stale sockets in socketMap

`socketMap` accumulates socket IDs but only cleans up on explicit `disconnect`. If a client reconnects (new socket ID), the old dead ID lingers and the new ID is never added (because `currentParticipantId` resets to null on new connections).

### Bug 5: No connection status feedback

Users have zero visibility into whether their connection is alive. On mobile, connections drop silently, and the UI looks normal while nothing works.

### Bug 6: XSS in renderParticipants (found in review)

`renderParticipants` uses raw string interpolation without escaping participant names. A malicious name like `<img src=x onerror=alert(1)>` would execute JavaScript.

### Bug 7: No suggestion ID validation on votes (found in review)

The `vote` handler doesn't verify that `suggestionId` actually exists in the session's suggestions array. A client could vote on a fabricated suggestion ID.

## Proposed Fixes

### Fix 1: Unified client-side rejoin via `connect` handler

**Decision (from architect review):** Make the `connect` event handler the *single* place where rejoins happen. Remove the inline rejoin code from page load. The `connect` event fires on both initial connection and reconnections, so this handles both cases without a double-rejoin race condition.

```js
// On page load, just restore from sessionStorage (no rejoin yet):
if (joinMatch) {
  sessionId = joinMatch[1];
  const saved = sessionStorage.getItem(`session_${sessionId}`);
  if (saved) {
    myParticipantId = saved;
    // rejoin will happen when connect fires
  } else {
    showScreen('join');
  }
}

socket.on('connect', () => {
  if (sessionId && myParticipantId) {
    socket.emit('rejoin', { sessionId, participantId: myParticipantId }, (res) => {
      if (res.error) {
        sessionStorage.removeItem(`session_${sessionId}`);
        myParticipantId = null;
        showScreen('join');
      }
    });
  }
});
```

### Fix 2: Replace (not accumulate) socketMap entries on rejoin

**Decision (from architect review):** On rejoin, replace the entire socket set for that participant rather than adding to it. A participant can only have one active socket (one browser tab). This eliminates stale socket accumulation.

```js
socket.on('rejoin', ({ sessionId, participantId }, cb) => {
  // ...validation...
  socketMap.set(participantId, new Set([socket.id]));
  // ...rest of handler...
});
```

### Fix 3: Client-side error handling on suggest

Check the callback response for errors. Only clear the form on success. Show inline feedback on failure.

### Fix 4: Connection status banner + input disabling

Add a fixed-position "Reconnecting..." banner on `disconnect`, hide on `connect`. Disable all buttons/inputs while disconnected.

### Fix 5: XSS fix in renderParticipants

Use the existing `esc()` function to escape participant names in `renderParticipants`.

### Fix 6: Validate suggestion ID on vote

Check that the `suggestionId` exists in `session.suggestions` before recording a vote.

### ~~Fix 7: Server-side dead socket detection~~ REMOVED

**Decision (from architect review):** Socket.io's `io.to(socketId).emit()` is fire-and-forget with no return value. There is no way to detect dead sockets at emit time. The socketMap replacement in Fix 2 handles the cleanup sufficiently.

### Fix 8: Session TTL cleanup

Add a periodic sweep or per-session timeout to remove sessions that have been inactive. Prevents unbounded memory growth.

### Fix 9: Accessibility — aria-labels on vote buttons

Add explicit `aria-label` attributes to emoji-only vote buttons for screen reader support.

## Data Model Changes

- Add `lastActivity` timestamp to sessions for TTL cleanup

## API Changes

No new events. Existing events are unchanged. The `rejoin` event is already implemented server-side; we just need the client to call it on reconnect.

## Architecture Decisions

1. **No polling fallback**: Socket.io already handles transport fallback (WebSocket → long-polling). We just need to handle the reconnection lifecycle properly.
2. **No server-side heartbeat**: Socket.io has built-in ping/pong. We don't need custom heartbeats.
3. **Optimistic UI with error rollback**: Keep the current pattern of immediate UI updates via state broadcasts, but add error feedback when actions fail.
4. **Connection banner, not toast**: A persistent banner while disconnected is better than toasts that disappear, since disconnection can last several seconds.
5. **Single rejoin path**: All rejoins (page load + reconnect) go through the `connect` handler to avoid race conditions.
6. **Replace, don't accumulate**: socketMap entries are fully replaced on rejoin rather than grown. One participant = one socket.
7. **No dead-socket detection at emit time**: Socket.io doesn't support this. Cleanup happens proactively on rejoin.

## Threat Model (from architect review)

- `participantId` (12-char nanoid, ~72 bits entropy) is an unauthenticated bearer token. Acceptable for a casual app with no login system.
- `sessionId` (8-char nanoid, ~48 bits) is visible in URLs. Combined with unlimited rejoin attempts, this could theoretically allow session hijacking. For the current use case (friends sharing links), this is acceptable. Rate limiting on rejoin would mitigate this if needed in the future.

## User Flow: Reconnection

1. Socket disconnects (network flap)
2. UI shows "Reconnecting..." banner, disables inputs
3. Socket.io auto-reconnects (built-in exponential backoff)
4. Client `connect` event fires → auto-emits `rejoin`
5. Server replaces socketMap entry, re-joins room
6. Server broadcasts fresh state to the rejoined participant
7. Banner hides, inputs re-enable
8. User sees current state (any suggestions/votes added while disconnected now visible)

## Testing Plan

- Test reconnection by having a client rejoin from a new socket and verifying state
- Test that stale sockets are replaced (not accumulated) on rejoin
- Test that suggest errors are properly returned to client
- Test that broadcastState reaches all registered participants
- Test that invalid suggestion IDs are rejected on vote
- Test session TTL cleanup
- Test concurrent join/suggest operations
- Test that all participant actions after rejoin work correctly (suggest, vote, startMatching)
