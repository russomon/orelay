const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const Ably = require('ably');

const PORT = process.env.PORT || 3000;
const ABLY_API_KEY = process.env.ABLY_API_KEY;
const SESSION_TIMEOUT_MS = 60 * 1000; // clean up unpaired sessions after 60s

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Ably connection for health monitoring (optional)
let ablyClient = null;
if (ABLY_API_KEY) {
  ablyClient = new Ably.Realtime({ key: ABLY_API_KEY });
  ablyClient.connection.on('connected', () => console.log('Ably: connected'));
  ablyClient.connection.on('failed', (err) => console.error('Ably: connection failed', err));
} else {
  console.warn('ABLY_API_KEY not set — Ably monitoring disabled');
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ably: ablyClient ? ablyClient.connection.state : 'not configured',
    uptime: process.uptime(),
    relaySessions: relaySessions.size
  });
});

// --- WebSocket Relay ---
// Both peers connect outbound to this server using the senderId as session key.
// The relay pairs them and forwards all data bidirectionally without inspection.

const relaySessions = new Map(); // sessionId -> { sender, receiver, timer }

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    // First message must be the join packet (JSON)
    if (!ws.sessionId) {
      try {
        const msg = JSON.parse(data);
        if (msg.type !== 'join-relay' || !msg.sessionId || !msg.role) return;

        ws.sessionId = msg.sessionId;
        ws.role = msg.role; // 'sender' or 'receiver'

        if (!relaySessions.has(ws.sessionId)) {
          // First peer to arrive — create session and start timeout
          const timer = setTimeout(() => {
            const session = relaySessions.get(ws.sessionId);
            if (session && !(session.sender && session.receiver)) {
              console.log(`Relay: session ${ws.sessionId} timed out waiting for second peer`);
              relaySessions.delete(ws.sessionId);
            }
          }, SESSION_TIMEOUT_MS);
          relaySessions.set(ws.sessionId, { sender: null, receiver: null, timer });
        }

        const session = relaySessions.get(ws.sessionId);
        if (!session) return;

        session[ws.role] = ws;
        console.log(`Relay: ${ws.role} joined session ${ws.sessionId.slice(0, 8)}...`);

        // Both peers connected — clear timeout and notify them
        if (session.sender && session.receiver) {
          clearTimeout(session.timer);
          session.timer = null;
          const ready = JSON.stringify({ type: 'relay-ready' });
          session.sender.send(ready);
          session.receiver.send(ready);
          console.log(`Relay: session ${ws.sessionId.slice(0, 8)}... ready`);
        }
      } catch (e) {
        console.error('Relay: bad join message', e.message);
      }
      return;
    }

    // Forward all subsequent messages to the other peer
    const session = relaySessions.get(ws.sessionId);
    if (!session) return;
    const other = ws.role === 'sender' ? session.receiver : session.sender;
    if (other && other.readyState === 1 /* OPEN */) {
      other.send(data, { binary: isBinary });
    }
  });

  ws.on('close', () => {
    if (!ws.sessionId) return;
    const session = relaySessions.get(ws.sessionId);
    if (!session) return;

    // Notify the other peer and clean up
    const other = ws.role === 'sender' ? session.receiver : session.sender;
    if (other && other.readyState === 1) {
      other.send(JSON.stringify({ type: 'relay-peer-disconnected' }));
    }
    if (session.timer) clearTimeout(session.timer);
    relaySessions.delete(ws.sessionId);
    console.log(`Relay: session ${ws.sessionId.slice(0, 8)}... closed (${ws.role} left)`);
  });

  ws.on('error', (err) => console.error('Relay WebSocket error:', err.message));
});

// Keepalive ping every 30s to detect dead connections
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Orelay relay server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  if (ablyClient) ablyClient.close();
  server.close(() => process.exit(0));
});
