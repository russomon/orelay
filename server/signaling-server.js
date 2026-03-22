const express = require('express');
const Ably = require('ably');

const PORT = process.env.PORT || 3000;
const ABLY_API_KEY = process.env.ABLY_API_KEY;

const app = express();

// Connect to Ably for server-side monitoring.
// Clients signal each other directly via Ably channels — no relay needed here.
let ablyClient = null;
if (ABLY_API_KEY) {
  ablyClient = new Ably.Realtime({ key: ABLY_API_KEY });
  ablyClient.connection.on('connected', () => console.log('Ably: connected'));
  ablyClient.connection.on('failed', (err) => console.error('Ably: connection failed', err));
} else {
  console.warn('ABLY_API_KEY not set — set it as an environment variable for monitoring');
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    ably: ablyClient ? ablyClient.connection.state : 'not configured',
    uptime: process.uptime()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Orelay signaling health endpoint running on port ${PORT}`);
  console.log('Peer signaling is handled directly via Ably channels — no server routing needed');
});

process.on('SIGTERM', () => {
  if (ablyClient) ablyClient.close();
  process.exit(0);
});
