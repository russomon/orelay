# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Main Application
```bash
npm install         # Install dependencies (includes ably)
npm start           # Run the Electron app in development
npm run build:mac   # Build macOS distributable
npm run build:win   # Build Windows distributable
npm run build:linux # Build Linux distributable
npm run build:all   # Build all platforms
```

### Signaling Health Check Server (optional, in `server/`)
```bash
cd server
npm install
ABLY_API_KEY=your_key npm start   # Run health check endpoint
npm run dev                        # Run with nodemon (auto-reload)
```

No lint or test commands are configured — the project uses plain vanilla JavaScript with no TypeScript, ESLint, or test framework.

## Architecture

Orelay is an Electron desktop app for direct P2P file transfer using WebRTC. File data never touches a server. Signaling (WebRTC handshake) is done directly between peers via [Ably](https://ably.com) pub/sub channels — no custom server required.

### Transfer Flow
1. **Sender** selects a file/folder → app generates a `.ort` token (base64-encoded JSON with metadata + peer ID)
2. Sender shares the `.ort` token file with the receiver out-of-band
3. Both peers connect to **Ably** using the embedded API key
4. Sender subscribes to `orelay:peer:{senderId}` channel; receiver publishes a `request` event to it
5. SDP offer/answer and ICE candidates are exchanged as `signal` events on each peer's channel
6. A direct **WebRTC data channel** is established between peers
7. File data streams in 64KB chunks, each SHA-256 verified, directly P2P
8. Transfer can resume after interruption — receiver tracks which chunks it has

### Key Source Files

- **`src/main.js`** — Electron main process: window creation, IPC handlers for file dialogs, `.ort` file association (double-click to open), prevents window close during active transfers.
- **`src/renderer.js`** — Renderer process UI logic: send/receive mode selection, token generation/display, download orchestration, progress tracking. `ABLY_API_KEY` constant is at the top of this file.
- **`src/transfer-manager.js`** — Core WebRTC + Ably engine: Ably Realtime client for signaling, peer connection setup (Google STUN servers), data channel management with flow control, chunked file/folder streaming, SHA-256 integrity checking, resume logic. Contains a critical SDP modification to remove Chrome's 30kbps bandwidth limit.
- **`src/index.html`** — Single-page UI rendered in the Electron BrowserWindow.
- **`server/signaling-server.js`** — Optional health check endpoint (Express). Connects to Ably for monitoring but does not route any signaling messages.

### IPC Boundary
`main.js` exposes file system operations to the renderer via `ipcMain`/`ipcRenderer`. The renderer cannot access the file system directly — it calls IPC handlers for file selection dialogs and reads file data through `transfer-manager.js`.

### Token Format
`.ort` tokens are base64-encoded JSON containing: file metadata (name, size, hash), the sender's peer ID, and a timestamp. The receiver uses `senderId` to know which Ably channel to publish a `request` event to. The `signalingServer` field was removed when migrating from Socket.IO to Ably (old tokens with that field still parse fine — it's ignored).

## Configuration

The Ably API key is set as `ABLY_API_KEY` in `src/renderer.js` (top of file). Update it and rebuild when rotating keys.
