const { describe, it, before, after, beforeEach } = require('node:test');
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

// Helper: create a session, return { socket, sessionId, participantId, state }
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

before(async () => {
  serverCtx = await start(PORT);
});

after(async () => {
  await stop();
});

beforeEach(() => {
  // Clear sessions between tests
  serverCtx.sessions.clear();
  serverCtx.socketMap.clear();
});

// ─── SESSION CREATION ───────────────────────────────────────────────

describe('session creation', () => {
  it('creates a session and returns ids', async () => {
    const { socket, sessionId, participantId } = await createSession();
    assert.ok(sessionId, 'should return sessionId');
    assert.ok(participantId, 'should return participantId');
    socket.disconnect();
  });

  it('host receives initial state in submission phase', async () => {
    const { socket, state } = await createSession('Alice');
    assert.equal(state.phase, 'submission');
    assert.equal(state.isHost, true);
    assert.equal(state.participants.length, 1);
    assert.equal(state.participants[0].name, 'Alice');
    assert.equal(state.participants[0].isHost, true);
    assert.deepEqual(state.suggestions, []);
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
    assert.equal(hostState.isHost, true);

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
    const host = await createSession();
    await emit(host.socket, 'suggest', { name: 'Pizza', pitch: '' });
    await emit(host.socket, 'startMatching');
    await waitForState(host.socket);

    const sock = await connect();
    const res = await emit(sock, 'join', { sessionId: host.sessionId, name: 'Late' });
    assert.ok(res.error);

    host.socket.disconnect();
    sock.disconnect();
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
    await emit(host.socket, 'suggest', { name: 'A' });
    const stateP = waitForState(host.socket);
    await emit(host.socket, 'suggest', { name: 'B' });
    const state = await stateP;

    assert.equal(state.suggestions.length, 2);
    host.socket.disconnect();
  });
});

// ─── PHASE TRANSITIONS ─────────────────────────────────────────────

describe('phase transitions', () => {
  it('host can start matching', async () => {
    const host = await createSession();
    await emit(host.socket, 'suggest', { name: 'Sushi' });

    const stateP = waitForState(host.socket);
    await emit(host.socket, 'startMatching');
    const state = await stateP;

    assert.equal(state.phase, 'matching');
    host.socket.disconnect();
  });

  it('non-host cannot start matching', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId);
    await emit(host.socket, 'suggest', { name: 'Sushi' });

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
    const host = await createSession();
    await emit(host.socket, 'suggest', { name: 'Ramen' });
    await emit(host.socket, 'startMatching');
    await waitForState(host.socket);

    const stateP = waitForState(host.socket);
    await emit(host.socket, 'endMatching');
    const state = await stateP;

    assert.equal(state.phase, 'results');
    host.socket.disconnect();
  });
});

// ─── VOTING ─────────────────────────────────────────────────────────

describe('voting', () => {
  it('records votes and tracks progress', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId);
    await emit(host.socket, 'suggest', { name: 'Pizza' });
    await emit(host.socket, 'startMatching');
    await waitForState(host.socket);

    // Get suggestion id from state
    const guestState = await waitForState(guest.socket);
    const sugId = guestState.suggestions[0].id;

    const hostStateP = waitForState(host.socket);
    await emit(guest.socket, 'vote', { suggestionId: sugId, vote: 'like' });
    const hostState = await hostStateP;

    // Guest should have 1 vote counted
    const guestParticipant = hostState.participants.find(p => !p.isHost);
    assert.equal(guestParticipant.votesCount, 1);

    host.socket.disconnect();
    guest.socket.disconnect();
  });

  it('prevents duplicate votes on same suggestion', async () => {
    const host = await createSession();
    await emit(host.socket, 'suggest', { name: 'Burgers' });
    await emit(host.socket, 'startMatching');
    const state = await waitForState(host.socket);
    const sugId = state.suggestions[0].id;

    await emit(host.socket, 'vote', { suggestionId: sugId, vote: 'like' });
    const res = await emit(host.socket, 'vote', { suggestionId: sugId, vote: 'meh' });
    assert.ok(res.error);

    host.socket.disconnect();
  });

  it('auto-transitions to results when all votes are in', async () => {
    const host = await createSession();
    const guest = await joinSession(host.sessionId);

    await emit(host.socket, 'suggest', { name: 'Thai' });
    await emit(host.socket, 'suggest', { name: 'Indian' });
    await emit(host.socket, 'startMatching');

    const matchState = await waitForState(guest.socket);
    const [sug1, sug2] = matchState.suggestions;

    // Host votes on both
    await emit(host.socket, 'vote', { suggestionId: sug1.id, vote: 'like' });
    await emit(host.socket, 'vote', { suggestionId: sug2.id, vote: 'meh' });

    // Guest votes on both — last vote should trigger results
    await emit(guest.socket, 'vote', { suggestionId: sug1.id, vote: 'like' });

    const resultsP = waitForState(guest.socket);
    await emit(guest.socket, 'vote', { suggestionId: sug2.id, vote: 'veto' });
    const results = await resultsP;

    assert.equal(results.phase, 'results');
    assert.equal(results.results.length, 2);
    // Thai: 2 likes = score 2, Indian: 1 meh + 1 veto = score -2
    assert.equal(results.results[0].name, 'Thai');
    assert.equal(results.results[0].counts.like, 2);
    assert.equal(results.results[1].name, 'Indian');
    assert.equal(results.results[1].counts.veto, 1);

    host.socket.disconnect();
    guest.socket.disconnect();
  });
});

// ─── REJOIN ─────────────────────────────────────────────────────────

describe('rejoin', () => {
  it('participant can rejoin and see current state', async () => {
    const host = await createSession();
    await emit(host.socket, 'suggest', { name: 'Pho' });

    // Simulate rejoin with a new socket but same participantId
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
});
