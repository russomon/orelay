const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Track connected peers
const peers = new Map();

io.on('connection', (socket) => {
  console.log('New connection:', socket.id);

  socket.on('register', (peerId) => {
    peers.set(peerId, socket.id);
    console.log(`Peer registered: ${peerId} -> ${socket.id}`);
    console.log(`Total peers online: ${peers.size}`);
  });

  socket.on('request-peer', (data) => {
    const { senderId, receiverId } = data;
    const senderSocketId = peers.get(senderId);
    
    if (senderSocketId) {
      // Notify sender that receiver wants to connect
      io.to(senderSocketId).emit('peer-requesting', {
        senderId,
        receiverId
      });
      console.log(`Connection requested: ${receiverId} -> ${senderId}`);
    } else {
      // Sender is not online
      socket.emit('error', { message: 'Sender is not currently online' });
      console.log(`Sender ${senderId} not found`);
    }
  });

  socket.on('signal', (data) => {
    const { to, from, sdp, candidate } = data;
    const targetSocketId = peers.get(to);
    
    if (targetSocketId) {
      io.to(targetSocketId).emit('signal', {
        from,
        sdp,
        candidate
      });
      console.log(`Signal forwarded: ${from} -> ${to}`);
    } else {
      console.log(`Target peer ${to} not found`);
    }
  });

  socket.on('disconnect', () => {
    // Remove peer from registry
    for (const [peerId, socketId] of peers.entries()) {
      if (socketId === socket.id) {
        peers.delete(peerId);
        console.log(`Peer disconnected: ${peerId}`);
        break;
      }
    }
    console.log(`Total peers online: ${peers.size}`);
  });
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    peers: peers.size,
    uptime: process.uptime()
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║  P2P Transfer Signaling Server         ║
╠════════════════════════════════════════╣
║  Status: Running                       ║
║  Port: ${PORT.toString().padEnd(32)}║
║  URL: http://localhost:${PORT.toString().padEnd(16)}║
╚════════════════════════════════════════╝

Server is ready to handle peer connections.
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
