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

## Proposed Fixes

### Fix 1: Client-side auto-rejoin on reconnect

Listen for socket.io's `connect` event (fires on initial connect AND reconnects). If we have a `sessionId` and `myParticipantId`, automatically emit `rejoin`. This is the highest-impact fix.

```js
socket.on('connect', () => {
  if (sessionId && myParticipantId) {
    socket.emit('rejoin', { sessionId, participantId: myParticipantId }, (res) => {
      if (res.error) { /* handle expired session */ }
    });
  }
});
```

### Fix 2: Server-side socket cleanup on rejoin

When a participant rejoins, clear their old socket IDs from `socketMap` and register only the new one. This prevents stale entries.

### Fix 3: Client-side error handling on suggest

Check the callback response for errors. Only clear the form on success. Show feedback on failure.

```js
socket.emit('suggest', { name, pitch }, (res) => {
  if (res?.error) { /* show error */ return; }
  // clear form
});
```

### Fix 4: Connection status indicator

Add a small visual indicator when the socket is disconnected/reconnecting so users know something is wrong and don't keep tapping buttons that won't work.

### Fix 5: Disable interactive elements while disconnected

Prevent users from submitting suggestions or votes while the socket is disconnected, since those actions will silently fail.

### Fix 6: Server-side broadcastState robustness

Clean up dead socket IDs from socketMap when `io.to(socketId).emit()` targets a non-existent socket. Also, on rejoin, immediately send a fresh state to the rejoining socket so they catch up.

## Data Model Changes

None — the in-memory data model is unchanged. The fixes are purely in the Socket.io connection lifecycle and client-side error handling.

## API Changes

No new events. Existing events are unchanged. The `rejoin` event is already implemented server-side; we just need the client to call it on reconnect.

## Architecture Decisions

1. **No polling fallback**: Socket.io already handles transport fallback (WebSocket → long-polling). We just need to handle the reconnection lifecycle properly.
2. **No server-side heartbeat**: Socket.io has built-in ping/pong. We don't need custom heartbeats.
3. **Optimistic UI with error rollback**: Keep the current pattern of immediate UI updates via state broadcasts, but add error feedback when actions fail.
4. **Connection banner, not toast**: A persistent banner while disconnected is better than toasts that disappear, since disconnection can last several seconds.

## User Flow: Reconnection

1. Socket disconnects (network flap)
2. UI shows "Reconnecting..." banner, disables inputs
3. Socket.io auto-reconnects (built-in exponential backoff)
4. Client `connect` event fires → auto-emits `rejoin`
5. Server re-registers socket in room and socketMap
6. Server broadcasts fresh state to the rejoined participant
7. Banner hides, inputs re-enable
8. User sees current state (any suggestions/votes added while disconnected now visible)

## Testing Plan

- Test reconnection by having a client rejoin and verifying they receive state
- Test that suggest errors are properly returned to client
- Test that stale sockets are cleaned from socketMap on rejoin
- Test that broadcastState reaches all registered participants
