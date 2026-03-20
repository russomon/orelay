# Orelay

**Direct peer-to-peer file transfer for professionals. No cloud. No limits. No waiting.**

Orelay is an open source desktop application built for video production workflows where large files need to move fast — directly from machine to machine, without touching a cloud server. Senders generate a small `.ort` token file and share it with recipients, who double-click it to begin a direct P2P download.

---

## Why Orelay?

Most file transfer tools upload your footage to a cloud server, then make your client download it back. That means every gigabyte travels twice, and you're paying for storage in the middle.

Orelay connects sender and recipient directly using WebRTC — the same technology that powers video calls — so your files take the shortest possible path.

- ✅ No file size limits
- ✅ No cloud storage required
- ✅ No per-GB fees
- ✅ Files never touch an intermediate server
- ✅ End-to-end encrypted (DTLS via WebRTC)
- ✅ Supports single files and entire folder transfers
- ✅ SHA-256 chunk verification for integrity

---

## How It Works

1. **Sender** selects a file or folder in Orelay and clicks **Generate Token**
2. Orelay creates a small `.ort` token file containing connection metadata
3. **Sender** shares the `.ort` token with the recipient (email, Slack, Messages — anything)
4. **Recipient** double-clicks the `.ort` file — Orelay opens automatically and begins the direct P2P transfer
5. The file streams directly from sender's machine to recipient's machine

The signaling server is only used for the initial WebRTC handshake. File data never passes through it.

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│   Sender    │         │ Signaling Server │         │  Receiver   │
│   (Seeder)  │         │   (WebSocket)    │         │ (Leecher)   │
└─────────────┘         └──────────────────┘         └─────────────┘
       │                         │                           │
       │  1. Register as peer    │                           │
       ├────────────────────────>│                           │
       │                         │   2. Register as peer     │
       │                         │<──────────────────────────┤
       │                         │                           │
       │  3. WebRTC handshake (SDP/ICE exchanged via signal) │
       │<═════════════════════════════════════════════════>│
       │                                                     │
       │         4. Direct P2P Data Channel (WebRTC)        │
       │<════════════════ File Chunks + Hashes ════════════>│
```

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- npm v9 or higher

### Installation

```bash
git clone https://github.com/russomon/orelay.git
cd orelay
npm install
cd server && npm install && cd ..
```

### Running in Development

```bash
# Terminal 1 — Start the signaling server
cd server
npm start

# Terminal 2 — Start the Electron app
npm start
```

### Building for Production

```bash
npm run build
```

Packaged apps will appear in the `dist/` folder.

---

## Deploying the Signaling Server

The signaling server is a lightweight Node.js + Socket.IO process. It only brokers the initial WebRTC handshake — no file data ever passes through it.

**Deploy to Railway (recommended — free tier available):**

```bash
cd server
# Push server/ directory to a new Railway project
# Set start command: node signaling-server.js
```

Once deployed, update the signaling server URL in your Orelay config to point to your hosted instance.

---

## Token Format

`.ort` token files are base64-encoded JSON containing:

```json
{
  "version": "1.0",
  "fileName": "footage.mov",
  "fileSize": 2147483648,
  "fileHash": "sha256:abc123...",
  "senderId": "peer-id-12345",
  "signalingServer": "https://orelay-production.up.railway.app",
  "timestamp": 1704067200000,
  "chunkSize": 1048576
}
```

---

## Architecture

| Component | File | Responsibility |
|---|---|---|
| Electron Main Process | `src/main.js` | Window management, file dialogs, IPC, `.ort` file association |
| Renderer Process | `src/renderer.js` | UI logic and user interactions |
| Transfer Manager | `src/transfer-manager.js` | WebRTC data channels, chunking, SHA-256 hashing |
| Signaling Server | `server/signaling-server.js` | WebSocket peer discovery and ICE exchange |

---

## Security

- **Encryption**: WebRTC Data Channels use DTLS encryption by default — all transfers are encrypted in transit
- **Integrity**: Every chunk is verified with SHA-256 hashing — corrupted transfers are detected and rejected
- **No Cloud Storage**: File data never touches the signaling server
- **Signaling**: Only connection metadata (SDP offers, ICE candidates) passes through the signaling server

---

## Contributing

Contributions are welcome! Here's how to get started:

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make your changes and test thoroughly
4. Submit a pull request with a clear description of what you changed and why

Please open an issue first for any significant changes so we can discuss the approach.

---

## License

Orelay is open source software licensed under the [MIT License](LICENSE).

---

## Built By

Orelay was created by [Orbit Olive](https://orbitolive.com) to solve a real problem in professional video production workflows: getting large files to clients fast, without cloud overhead.
