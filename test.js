const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: Client } = require('socket.io-client');
const { start, stop } = require('./server');

const PORT = 4444;
const URL = `http://localhost:${PORT}`;

let serverCtx;

function connect() {
  return new Promise((resolve) => {
    const sock = Client(URL, { forceNew: true });
    sock.on('connect', () => resolve(sock));
  });
}

function emit(sock, event, ...args) {
  return new Promise((resolve) => {
    sock.emit(event, ...args, resolve);
  });
}

function waitForState(sock) {
  return new Promise((resolve) => {
    sock.once('state', resolve);
  });
}

// Emit and wait for resulting state broadcast
async function emitAndWait(sock, event, ...args) {
  const p = waitForState(sock);
  const res = await emit(sock, event, ...args);
  const state = await p;
  return { res, state };
}

// Helper: create a session
async function createSession(name = 'Host') {
  const sock = await connect();
  const stateP = waitForState(sock);
  const res = await emit(sock, 'create', name);
  const state = await stateP;
  return { socket: sock, sessionId: res.sessionId, participantId: res.participantId, state };
}

// Helper: join an existing session
async function joinSession(sessionId, name = 'Guest') {
  const sock = await connect();
  const stateP = waitForState(sock);
  const res = await emit(sock, 'join', { sessionId, name });
  const state = await stateP;
  return { socket: sock, participantId: res.participantId, state };
}

// Helper: set up a session in matching phase with given suggestions
async function setupMatching(suggestions = ['Pizza'], guestCount = 1) {
  const host = await createSession();
  const guests = [];
  for (let i = 0; i < guestCount; i++) {
    guests.push(await joinSession(host.sessionId, `Guest${i + 1}`));
  }

  for (const name of suggestions) {
    await emitAndWait(host.socket, 'suggest', { name, pitch: '' });
  }

  const { state } = await emitAndWait(host.socket, 'startMatching');
  // Drain state events from guest sockets
  for (const g of guests) {
    await waitForState(g.socket);
  }

  return { host, guests, state };
}

before(async () => {
  serverCtx = await start(PORT);
});

after(async () => {
  await stop();
});

// ─── SESSION CREATION ───────────────────────────────────────────────

describe('session creation', () => {
  it('creates a session and returns ids', async () => {
    const { socket, sessionId, participantId } = await createSession();
    assert.ok(sessionId);
    assert.ok(participantId);
    socket.disconnect();
  });

  it('host receives initial state in submission phase', async () => {
    const { socket, state } = await createSession('Alice');
    assert.equal(state.phase, 'submission');
    assert.equal(state.isHost, true);
    assert.equal(state.participants.length, 1);
    assert.equal(state.participants[0].name, 'Alice');
    assert.deepEqual(state.suggestions, []);
    socket.disconnect();
  });

  it('session has lastActivity timestamp', async () => {
    const { socket, sessionId } = await createSession();
    const session = serverCtx.sessions.get(sessionId);
    assert.ok(session.lastActivity);
    assert.ok(Date.now() - session.lastActivity < 1000);
    socket.disconnect();
  });
});

// ─── JOINING ────────────────────────────────────────────────────────

describe('joining', () => {
  it('participant can join and both see updated state', async () => {
    const host = await createSession('Host');
    const hostStateP = waitForState(host.socket);
    const guest = await joinSession(host.sessionId, 'Guest');

    assert.ok(guest.participantId);
    assert.equal(guest.state.participants.length, 2);

    const hostState = await hostStateP;
    assert.equal(hostState.participants.length, 2);

    host.socket.disconnect();
    guest.socket.disconnect();
  });

  it('rejects join for nonexistent session', async () => {
    const sock = await connect();
    const res = await emit(sock, 'join', { sessionId: 'nope', name: 'X' });
    assert.ok(res.error);
    sock.disconnect();
  });

  it('rejects join after matching has started', async () => {
    const { host } = await setupMatching(['Pizza'], 0);

    const sock = await connect();
    const res = await emit(sock, 'join', { sessionId: host.sessionId, name: 'Late' });
    assert.ok(res.error);

    host.socket.disconnect();
    sock.disconnect();
  });

  it('multiple participants can join concurrently', async () => {
    const host = await createSession('Host');

    // Join 3 guests in rapid succession
    const joins = [
      joinSession(host.sessionId, 'A'),
      joinSession(host.sessionId, 'B'),
      joinSession(host.sessionId, 'C'),
    ];
    const guests = await Promise.all(joins);

    // All should have unique participant IDs
    const ids = guests.map(g => g.participantId);
    assert.equal(new Set(ids).size, 3);

    // Wait for state to settle, then check participant count
    // The last state broadcast should have all 4 participants
    const stateP = waitForState(host.socket);
    // Trigger a fresh broadcast by adding a suggestion
    await emit(host.socket, 'suggest', { name: 'Test' });
    const state = await stateP;
    assert.equal(state.participants.length, 4);

    host.socket.disconnect();
    guests.forEach(g => g.socket.disconnect());
  });
});

// ─── SUGGESTIONS ────────────────────────────────────────────────────

describe('suggestions', () => {
  it('adds suggestions visible to all participants', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId, 'G');

    const guestStateP = waitForState(guest.socket);
    await emit(host.socket, 'suggest', { name: 'Tacos', pitch: 'Best in town' });
    const guestState = await guestStateP;

    assert.equal(guestState.suggestions.length, 1);
    assert.equal(guestState.suggestions[0].name, 'Tacos');
    assert.equal(guestState.suggestions[0].pitch, 'Best in town');

    host.socket.disconnect();
    guest.socket.disconnect();
  });

  it('multiple suggestions accumulate', async () => {
    const host = await createSession();
    await emitAndWait(host.socket, 'suggest', { name: 'A' });
    const { state } = await emitAndWait(host.socket, 'suggest', { name: 'B' });

    assert.equal(state.suggestions.length, 2);
    host.socket.disconnect();
  });

  it('rejects suggest when not in a session', async () => {
    const sock = await connect();
    const res = await emit(sock, 'suggest', { name: 'Orphan' });
    assert.ok(res.error);
    sock.disconnect();
  });

  it('rejects suggest after matching phase', async () => {
    const { host } = await setupMatching(['Pizza'], 0);
    const res = await emit(host.socket, 'suggest', { name: 'Late entry' });
    assert.ok(res.error);
    host.socket.disconnect();
  });

  it('suggestion with empty pitch defaults to empty string', async () => {
    const host = await createSession();
    const { state } = await emitAndWait(host.socket, 'suggest', { name: 'NoPitch' });
    assert.equal(state.suggestions[0].pitch, '');
    host.socket.disconnect();
  });

  it('updates lastActivity on suggest', async () => {
    const host = await createSession();
    const session = serverCtx.sessions.get(host.sessionId);
    const before = session.lastActivity;
    await emitAndWait(host.socket, 'suggest', { name: 'Fresh' });
    assert.ok(session.lastActivity >= before);
    host.socket.disconnect();
  });

  it('guest can add suggestions too', async () => {
    const host = await createSession();
    // Drain host's state from guest join
    const hostJoinP = waitForState(host.socket);
    const guest = await joinSession(host.sessionId, 'Guest');
    await hostJoinP;

    const hostStateP = waitForState(host.socket);
    await emit(guest.socket, 'suggest', { name: 'GuestPick', pitch: 'Trust me' });
    const hostState = await hostStateP;

    assert.equal(hostState.suggestions.length, 1);
    assert.equal(hostState.suggestions[0].name, 'GuestPick');

    host.socket.disconnect();
    guest.socket.disconnect();
  });
});

// ─── PHASE TRANSITIONS ─────────────────────────────────────────────

describe('phase transitions', () => {
  it('host can start matching', async () => {
    const host = await createSession();
    await emitAndWait(host.socket, 'suggest', { name: 'Sushi' });
    const { state } = await emitAndWait(host.socket, 'startMatching');

    assert.equal(state.phase, 'matching');
    host.socket.disconnect();
  });

  it('non-host cannot start matching', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId);
    await emitAndWait(host.socket, 'suggest', { name: 'Sushi' });

    const res = await emit(guest.socket, 'startMatching');
    assert.ok(res.error);

    host.socket.disconnect();
    guest.socket.disconnect();
  });

  it('cannot start matching with no suggestions', async () => {
    const host = await createSession();
    const res = await emit(host.socket, 'startMatching');
    assert.ok(res.error);
    host.socket.disconnect();
  });

  it('host can force end matching', async () => {
    const { host } = await setupMatching(['Ramen'], 0);
    const { state } = await emitAndWait(host.socket, 'endMatching');

    assert.equal(state.phase, 'results');
    host.socket.disconnect();
  });

  it('non-host cannot end matching', async () => {
    const { host, guests } = await setupMatching(['Ramen'], 1);
    const res = await emit(guests[0].socket, 'endMatching');
    assert.ok(res.error);
    host.socket.disconnect();
    guests[0].socket.disconnect();
  });

  it('guests see matching phase after host starts it', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId, 'G');

    // Drain guest's state from suggest
    const guestSugP = waitForState(guest.socket);
    await emitAndWait(host.socket, 'suggest', { name: 'Ramen' });
    await guestSugP;

    const guestStateP = waitForState(guest.socket);
    await emit(host.socket, 'startMatching');
    const guestState = await guestStateP;

    assert.equal(guestState.phase, 'matching');
    assert.equal(guestState.suggestions.length, 1);

    host.socket.disconnect();
    guest.socket.disconnect();
  });
});

// ─── VOTING ─────────────────────────────────────────────────────────

describe('voting', () => {
  it('records votes and tracks progress', async () => {
    const { host, guests, state } = await setupMatching(['Pizza'], 1);
    const sugId = state.suggestions[0].id;

    const hostStateP = waitForState(host.socket);
    await emit(guests[0].socket, 'vote', { suggestionId: sugId, vote: 'like' });
    const hostState = await hostStateP;

    const guestParticipant = hostState.participants.find(p => !p.isHost);
    assert.equal(guestParticipant.votesCount, 1);

    host.socket.disconnect();
    guests[0].socket.disconnect();
  });

  it('prevents duplicate votes on same suggestion', async () => {
    const { host, state } = await setupMatching(['Burgers'], 0);
    const sugId = state.suggestions[0].id;

    await emitAndWait(host.socket, 'vote', { suggestionId: sugId, vote: 'like' });
    const res = await emit(host.socket, 'vote', { suggestionId: sugId, vote: 'meh' });
    assert.ok(res.error);

    host.socket.disconnect();
  });

  it('auto-transitions to results when all votes are in', async () => {
    const { host, guests, state } = await setupMatching(['Thai', 'Indian'], 1);
    const [sug1, sug2] = state.suggestions;
    const guest = guests[0];

    // Collect states on guest socket — wait until we see results phase
    const resultsP = new Promise((resolve) => {
      guest.socket.on('state', (s) => {
        if (s.phase === 'results') resolve(s);
      });
    });

    // All votes
    await emit(host.socket, 'vote', { suggestionId: sug1.id, vote: 'like' });
    await emit(host.socket, 'vote', { suggestionId: sug2.id, vote: 'meh' });
    await emit(guest.socket, 'vote', { suggestionId: sug1.id, vote: 'like' });
    await emit(guest.socket, 'vote', { suggestionId: sug2.id, vote: 'veto' });

    const results = await resultsP;

    assert.equal(results.phase, 'results');
    assert.equal(results.results.length, 2);
    assert.equal(results.results[0].name, 'Thai');
    assert.equal(results.results[0].counts.like, 2);
    assert.equal(results.results[1].name, 'Indian');
    assert.equal(results.results[1].counts.veto, 1);

    host.socket.disconnect();
    guest.socket.disconnect();
  });

  it('rejects vote with invalid suggestion ID', async () => {
    const { host } = await setupMatching(['Pizza'], 0);
    const res = await emit(host.socket, 'vote', { suggestionId: 'fakeid', vote: 'like' });
    assert.ok(res.error);
    assert.equal(res.error, 'Invalid suggestion');
    host.socket.disconnect();
  });

  it('rejects vote with invalid vote type', async () => {
    const { host, state } = await setupMatching(['Pizza'], 0);
    const sugId = state.suggestions[0].id;
    const res = await emit(host.socket, 'vote', { suggestionId: sugId, vote: 'love' });
    assert.ok(res.error);
    host.socket.disconnect();
  });

  it('rejects vote when not in matching phase', async () => {
    const host = await createSession();
    const res = await emit(host.socket, 'vote', { suggestionId: 'x', vote: 'like' });
    assert.ok(res.error);
    host.socket.disconnect();
  });

  it('votedOn tracks which suggestions user has voted on', async () => {
    const { host, state } = await setupMatching(['A', 'B'], 0);
    const [sug1, sug2] = state.suggestions;

    const { state: s1 } = await emitAndWait(host.socket, 'vote', { suggestionId: sug1.id, vote: 'like' });
    assert.equal(s1.votedOn.length, 1);
    assert.ok(s1.votedOn.includes(sug1.id));

    const { state: s2 } = await emitAndWait(host.socket, 'vote', { suggestionId: sug2.id, vote: 'meh' });
    assert.equal(s2.votedOn.length, 2);

    host.socket.disconnect();
  });

  it('veto counts as negative in scoring', async () => {
    const { host, state } = await setupMatching(['Liked', 'Vetoed'], 0);
    const [sug1, sug2] = state.suggestions;

    await emitAndWait(host.socket, 'vote', { suggestionId: sug1.id, vote: 'like' });
    const { state: final } = await emitAndWait(host.socket, 'vote', { suggestionId: sug2.id, vote: 'veto' });

    // Should auto-transition to results
    assert.equal(final.phase, 'results');
    assert.equal(final.results[0].name, 'Liked');
    assert.equal(final.results[0].score, 1);
    assert.equal(final.results[1].name, 'Vetoed');
    assert.equal(final.results[1].score, -1);

    host.socket.disconnect();
  });
});

// ─── REJOIN ─────────────────────────────────────────────────────────

describe('rejoin', () => {
  it('participant can rejoin and see current state', async () => {
    const host = await createSession();
    await emitAndWait(host.socket, 'suggest', { name: 'Pho' });

    const sock2 = await connect();
    const stateP = waitForState(sock2);
    const res = await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: host.participantId,
    });

    assert.ok(!res.error);
    const state = await stateP;
    assert.equal(state.suggestions.length, 1);

    host.socket.disconnect();
    sock2.disconnect();
  });

  it('rejects rejoin with bad credentials', async () => {
    const sock = await connect();
    const res = await emit(sock, 'rejoin', {
      sessionId: 'fake',
      participantId: 'fake',
    });
    assert.ok(res.error);
    sock.disconnect();
  });

  it('rejoin replaces stale socket IDs in socketMap', async () => {
    const host = await createSession();
    const oldSocketId = host.socket.id;

    // Verify old socket is in socketMap
    assert.ok(serverCtx.socketMap.get(host.participantId).has(oldSocketId));

    // Rejoin from a new socket (simulating reconnection)
    const sock2 = await connect();
    const stateP = waitForState(sock2);
    await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: host.participantId,
    });
    await stateP;

    // Old socket should be gone, new socket should be present
    const sockets = serverCtx.socketMap.get(host.participantId);
    assert.equal(sockets.size, 1);
    assert.ok(sockets.has(sock2.id));
    assert.ok(!sockets.has(oldSocketId));

    host.socket.disconnect();
    sock2.disconnect();
  });

  it('participant can act after rejoin (suggest)', async () => {
    const host = await createSession();
    await emitAndWait(host.socket, 'suggest', { name: 'Before' });

    // Rejoin from new socket
    const sock2 = await connect();
    const stateP = waitForState(sock2);
    await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: host.participantId,
    });
    await stateP;

    // Now suggest from the rejoined socket
    const { state } = await emitAndWait(sock2, 'suggest', { name: 'After' });
    assert.equal(state.suggestions.length, 2);
    assert.equal(state.suggestions[1].name, 'After');

    host.socket.disconnect();
    sock2.disconnect();
  });

  it('participant can act after rejoin (startMatching)', async () => {
    const host = await createSession();
    await emitAndWait(host.socket, 'suggest', { name: 'Something' });

    // Rejoin from new socket
    const sock2 = await connect();
    const stateP = waitForState(sock2);
    await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: host.participantId,
    });
    await stateP;

    // Host should be able to start matching from rejoined socket
    const { state } = await emitAndWait(sock2, 'startMatching');
    assert.equal(state.phase, 'matching');

    host.socket.disconnect();
    sock2.disconnect();
  });

  it('participant can act after rejoin (vote)', async () => {
    const { host, state } = await setupMatching(['Pizza'], 0);
    const sugId = state.suggestions[0].id;

    // Rejoin from new socket
    const sock2 = await connect();
    const stateP = waitForState(sock2);
    await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: host.participantId,
    });
    await stateP;

    // Vote from rejoined socket
    const { state: voteState } = await emitAndWait(sock2, 'vote', { suggestionId: sugId, vote: 'like' });
    assert.equal(voteState.phase, 'results'); // solo host, auto-transition
    assert.equal(voteState.results[0].counts.like, 1);

    host.socket.disconnect();
    sock2.disconnect();
  });

  it('rejoin during matching phase preserves vote progress', async () => {
    const { host, guests, state } = await setupMatching(['A', 'B'], 1);
    const [sug1] = state.suggestions;

    // Guest votes on first suggestion
    await emitAndWait(guests[0].socket, 'vote', { suggestionId: sug1.id, vote: 'like' });

    // Guest rejoins from new socket
    const sock2 = await connect();
    const stateP = waitForState(sock2);
    await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: guests[0].participantId,
    });
    const rejoinState = await stateP;

    // Should see the vote they already cast
    assert.equal(rejoinState.votedOn.length, 1);
    assert.ok(rejoinState.votedOn.includes(sug1.id));

    host.socket.disconnect();
    guests[0].socket.disconnect();
    sock2.disconnect();
  });

  it('rejects rejoin with valid session but wrong participant', async () => {
    const host = await createSession();
    const sock = await connect();
    const res = await emit(sock, 'rejoin', {
      sessionId: host.sessionId,
      participantId: 'wrongperson',
    });
    assert.ok(res.error);
    host.socket.disconnect();
    sock.disconnect();
  });
});

// ─── BROADCAST RELIABILITY ──────────────────────────────────────────

describe('broadcast reliability', () => {
  it('all participants receive state after suggest', async () => {
    const host = await createSession();
    // Drain host state from g1 join
    const hJoin1 = waitForState(host.socket);
    const g1 = await joinSession(host.sessionId, 'G1');
    await hJoin1;
    // Drain host + g1 state from g2 join
    const hJoin2 = waitForState(host.socket);
    const g1Join2 = waitForState(g1.socket);
    const g2 = await joinSession(host.sessionId, 'G2');
    await Promise.all([hJoin2, g1Join2]);

    const p1 = waitForState(g1.socket);
    const p2 = waitForState(g2.socket);
    const pH = waitForState(host.socket);

    await emit(host.socket, 'suggest', { name: 'Test' });

    const [s1, s2, sH] = await Promise.all([p1, p2, pH]);
    assert.equal(s1.suggestions.length, 1);
    assert.equal(s2.suggestions.length, 1);
    assert.equal(sH.suggestions.length, 1);

    host.socket.disconnect();
    g1.socket.disconnect();
    g2.socket.disconnect();
  });

  it('all participants receive state after join', async () => {
    const host = await createSession();
    // Drain host state from g1 join
    const hJoin1 = waitForState(host.socket);
    const g1 = await joinSession(host.sessionId, 'G1');
    await hJoin1;

    // When G2 joins, both host and G1 should get updated state
    const pH = waitForState(host.socket);
    const p1 = waitForState(g1.socket);
    const g2 = await joinSession(host.sessionId, 'G2');

    const [hostState, g1State] = await Promise.all([pH, p1]);
    assert.equal(hostState.participants.length, 3);
    assert.equal(g1State.participants.length, 3);
    assert.equal(g2.state.participants.length, 3);

    host.socket.disconnect();
    g1.socket.disconnect();
    g2.socket.disconnect();
  });

  it('rejoined socket receives broadcasts from other participants', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId, 'Guest');

    // Guest reconnects
    const sock2 = await connect();
    const stateP = waitForState(sock2);
    await emit(sock2, 'rejoin', {
      sessionId: host.sessionId,
      participantId: guest.participantId,
    });
    await stateP;

    // Host adds suggestion — rejoined guest should see it
    const guestStateP = waitForState(sock2);
    await emit(host.socket, 'suggest', { name: 'NewPlace' });
    const guestState = await guestStateP;
    assert.equal(guestState.suggestions.length, 1);
    assert.equal(guestState.suggestions[0].name, 'NewPlace');

    host.socket.disconnect();
    guest.socket.disconnect();
    sock2.disconnect();
  });
});

// ─── SESSION TTL ────────────────────────────────────────────────────

describe('session TTL', () => {
  it('sessions have lastActivity timestamp', async () => {
    const { socket, sessionId } = await createSession();
    const session = serverCtx.sessions.get(sessionId);
    assert.ok(typeof session.lastActivity === 'number');
    assert.ok(session.lastActivity > 0);
    socket.disconnect();
  });

  it('lastActivity updates on actions', async () => {
    const host = await createSession();
    const session = serverCtx.sessions.get(host.sessionId);

    const t1 = session.lastActivity;
    await emitAndWait(host.socket, 'suggest', { name: 'A' });
    const t2 = session.lastActivity;
    assert.ok(t2 >= t1);

    await emitAndWait(host.socket, 'startMatching');
    const t3 = session.lastActivity;
    assert.ok(t3 >= t2);

    host.socket.disconnect();
  });
});
