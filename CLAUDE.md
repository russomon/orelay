# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Main Application
```bash
npm start           # Run the Electron app in development
npm run build:mac   # Build macOS distributable
npm run build:win   # Build Windows distributable
npm run build:linux # Build Linux distributable
npm run build:all   # Build all platforms
```

### Signaling Server (in `server/`)
```bash
cd server
npm start           # Run production server
npm run dev         # Run with nodemon (auto-reload)
```

No lint or test commands are configured — the project uses plain vanilla JavaScript with no TypeScript, ESLint, or test framework.

## Architecture

Orelay is an Electron desktop app for direct P2P file transfer using WebRTC. File data never touches a server — the signaling server only brokers the WebRTC handshake.

### Transfer Flow
1. **Sender** selects a file/folder → app generates a `.ort` token (base64-encoded JSON with metadata + peer ID)
2. Sender shares the `.ort` token file with the receiver out-of-band
3. Both peers connect to the **signaling server** via Socket.IO WebSocket
4. SDP/ICE candidates are exchanged through the signaling server to set up WebRTC
5. A direct **WebRTC data channel** is established between peers
6. File data streams in 64KB chunks, each SHA-256 verified, directly P2P
7. Transfer can resume after interruption — receiver tracks which chunks it has

### Key Source Files

- **`src/main.js`** — Electron main process: window creation, IPC handlers for file dialogs, `.ort` file association (double-click to open), prevents window close during active transfers.
- **`src/renderer.js`** — Renderer process UI logic: send/receive mode selection, token generation/display, download orchestration, progress tracking. The signaling server URL is hardcoded at the top of this file.
- **`src/transfer-manager.js`** — Core WebRTC engine: peer connection setup (Google STUN servers), data channel management with flow control, chunked file/folder streaming, SHA-256 integrity checking, resume logic. Contains a critical SDP modification to remove Chrome's 30kbps bandwidth limit.
- **`src/index.html`** — Single-page UI rendered in the Electron BrowserWindow.
- **`server/signaling-server.js`** — Express + Socket.IO signaling broker: peer registration, SDP/ICE forwarding, health check at `GET /health`. Deployed to Railway at `https://orelay-production.up.railway.app`.

### IPC Boundary
`main.js` exposes file system operations to the renderer via `ipcMain`/`ipcRenderer`. The renderer cannot access the file system directly — it calls IPC handlers for file selection dialogs and reads file data through `transfer-manager.js`.

### Token Format
`.ort` tokens are base64-encoded JSON containing: file metadata (name, size, hash), the sender's peer ID, signaling server URL, and a timestamp. The receiver parses this to connect to the right peer on the signaling server.

## Deployment

The signaling server URL is set in `src/renderer.js` (top of file). To point at a different server, update that constant and rebuild the app. The `deploy-server.sh` script assists with VPS deployment.
