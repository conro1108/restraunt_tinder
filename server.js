const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Serve index.html for /s/:id join links
app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => res.sendStatus(200));

// In-memory session store
const sessions = new Map();

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

function createSession(hostName) {
  const id = nanoid(8);
  const hostId = nanoid(12);
  const session = {
    id,
    hostId,
    phase: 'submission', // submission | matching | results
    participants: new Map([[hostId, { id: hostId, name: hostName, votesCount: 0 }]]),
    suggestions: [],
    votes: new Map(), // participantId -> Map(suggestionId -> 'like'|'meh'|'veto')
    lastActivity: Date.now(),
  };
  sessions.set(id, session);
  return { session, hostId };
}

function sessionState(session, participantId) {
  const totalSuggestions = session.suggestions.length;
  const participants = [...session.participants.values()].map(p => ({
    name: p.name,
    votesCount: p.votesCount,
    isHost: p.id === session.hostId,
  }));

  const base = {
    id: session.id,
    phase: session.phase,
    participants,
    isHost: participantId === session.hostId,
    totalSuggestions,
  };

  if (session.phase === 'submission' || session.phase === 'matching') {
    base.suggestions = session.suggestions.map(s => ({
      id: s.id,
      name: s.name,
      pitch: s.pitch,
    }));
  }

  if (session.phase === 'results') {
    base.results = getResults(session);
  }

  // Send which suggestions this participant has already voted on
  const myVotes = session.votes.get(participantId);
  base.votedOn = myVotes ? [...myVotes.keys()] : [];

  return base;
}

function getResults(session) {
  const results = session.suggestions.map(s => {
    const counts = { like: 0, meh: 0, veto: 0 };
    for (const [, votes] of session.votes) {
      const vote = votes.get(s.id);
      if (vote) counts[vote]++;
    }
    const score = counts.like - counts.meh - counts.veto;
    return { id: s.id, name: s.name, pitch: s.pitch, counts, score };
  });
  return results.sort((a, b) => b.score - a.score);
}

function checkAllVotesIn(session) {
  const totalSuggestions = session.suggestions.length;
  for (const [, participant] of session.participants) {
    if (participant.votesCount < totalSuggestions) return false;
  }
  return true;
}

// Track socket -> participant mapping for targeted broadcasts
const socketMap = new Map(); // participantId -> Set<socketId>

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivity > SESSION_TTL_MS) {
      for (const participantId of session.participants.keys()) {
        socketMap.delete(participantId);
      }
      sessions.delete(id);
    }
  }
}, 15 * 60 * 1000); // run every 15 minutes

io.on('connection', (socket) => {
  let currentSession = null;
  let currentParticipantId = null;

  function registerSocket() {
    if (!currentParticipantId) return;
    if (!socketMap.has(currentParticipantId)) socketMap.set(currentParticipantId, new Set());
    socketMap.get(currentParticipantId).add(socket.id);
  }

  socket.on('disconnect', () => {
    if (currentParticipantId && socketMap.has(currentParticipantId)) {
      socketMap.get(currentParticipantId).delete(socket.id);
    }
  });

  socket.on('create', (name, cb) => {
    if (typeof cb !== 'function') return;
    if (typeof name !== 'string' || !name.trim() || name.length > 60) return cb({ error: 'Invalid name' });
    const { session, hostId } = createSession(name.trim());
    currentSession = session;
    currentParticipantId = hostId;
    registerSocket();
    cb({ sessionId: session.id, participantId: hostId });
    broadcastState(session);
  });

  socket.on('join', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const { sessionId, name } = data;
    if (typeof name !== 'string' || !name.trim() || name.length > 60) return cb({ error: 'Invalid name' });
    const session = sessions.get(sessionId);
    if (!session) return cb({ error: 'Session not found' });
    if (session.phase !== 'submission') return cb({ error: 'Session already in progress' });
    if (session.participants.size >= 50) return cb({ error: 'Session is full' });

    const participantId = nanoid(12);
    session.participants.set(participantId, { id: participantId, name: name.trim(), votesCount: 0 });
    currentSession = session;
    currentParticipantId = participantId;
    session.lastActivity = Date.now();
    registerSocket();
    cb({ sessionId: session.id, participantId });
    broadcastState(session);
  });

  socket.on('rejoin', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const { sessionId, participantId } = data;
    const session = sessions.get(sessionId);
    if (!session || !session.participants.has(participantId)) {
      return cb({ error: 'Session not found' });
    }
    currentSession = session;
    currentParticipantId = participantId;
    session.lastActivity = Date.now();
    socketMap.set(participantId, new Set([socket.id]));
    cb({});
    broadcastState(session);
  });

  socket.on('suggest', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const { name, pitch } = data;
    if (!currentSession || currentSession.phase !== 'submission') return cb({ error: 'Cannot add suggestions now' });
    if (typeof name !== 'string' || !name.trim()) return cb({ error: 'Name required' });
    if (name.length > 200) return cb({ error: 'Name too long' });
    if (pitch != null && typeof pitch !== 'string') return cb({ error: 'Invalid pitch' });
    if (pitch && pitch.length > 1000) return cb({ error: 'Pitch too long' });
    if (currentSession.suggestions.length >= 50) return cb({ error: 'Too many suggestions' });
    const suggestion = { id: nanoid(8), name: name.trim(), pitch: (pitch || '').trim() };
    currentSession.suggestions.push(suggestion);
    currentSession.lastActivity = Date.now();
    cb({});
    broadcastState(currentSession);
  });

  socket.on('startMatching', (cb) => {
    if (typeof cb !== 'function') return;
    if (!currentSession || currentParticipantId !== currentSession.hostId) return cb({ error: 'Not host' });
    if (currentSession.suggestions.length === 0) return cb({ error: 'No suggestions yet' });
    currentSession.phase = 'matching';
    currentSession.lastActivity = Date.now();
    cb({});
    broadcastState(currentSession);
  });

  socket.on('vote', (data, cb) => {
    if (typeof cb !== 'function') return;
    if (!data || typeof data !== 'object') return cb({ error: 'Invalid request' });
    const { suggestionId, vote } = data;
    if (!currentSession || !currentParticipantId || currentSession.phase !== 'matching') return cb({ error: 'Not in matching phase' });
    if (!['like', 'meh', 'veto'].includes(vote)) return cb({ error: 'Invalid vote' });
    const suggestionExists = currentSession.suggestions.some(s => s.id === suggestionId);
    if (!suggestionExists) return cb({ error: 'Invalid suggestion' });

    if (!currentSession.votes.has(currentParticipantId)) {
      currentSession.votes.set(currentParticipantId, new Map());
    }
    const myVotes = currentSession.votes.get(currentParticipantId);
    if (myVotes.has(suggestionId)) return cb({ error: 'Already voted' });

    myVotes.set(suggestionId, vote);
    currentSession.participants.get(currentParticipantId).votesCount = myVotes.size;
    currentSession.lastActivity = Date.now();
    cb({});

    if (checkAllVotesIn(currentSession)) {
      currentSession.phase = 'results';
    }
    broadcastState(currentSession);
  });

  socket.on('endMatching', (cb) => {
    if (typeof cb !== 'function') return;
    if (!currentSession || currentParticipantId !== currentSession.hostId) return cb({ error: 'Not host' });
    currentSession.phase = 'results';
    currentSession.lastActivity = Date.now();
    cb({});
    broadcastState(currentSession);
  });
});

function broadcastState(session) {
  for (const [participantId] of session.participants) {
    const sockets = socketMap.get(participantId);
    if (!sockets) continue;
    const s = sessionState(session, participantId);
    for (const socketId of sockets) {
      io.to(socketId).emit('state', s);
    }
  }
}

function start(port) {
  return new Promise((resolve) => {
    const p = port || process.env.PORT || 3000;
    server.listen(p, () => {
      console.log(`Server running on http://localhost:${p}`);
      resolve({ server, io, sessions, socketMap });
    });
  });
}

function stop() {
  clearInterval(cleanupInterval);
  return new Promise((resolve) => {
    io.close();
    server.close(resolve);
  });
}

// Start directly if run as main script
if (require.main === module) {
  start();
}

module.exports = { start, stop };
