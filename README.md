# P2P Transfer - Peer-to-Peer File Transfer Application

A desktop application for transferring large files directly between computers without cloud storage, using token-based sharing and WebRTC technology.

## Features

- **True Peer-to-Peer**: Files transfer directly between sender and receiver
- **Token-Based Sharing**: Small `.ort` token files contain connection info
- **Resume Capability**: Automatic resume on connection interruption
- **File Verification**: SHA-256 hash verification ensures file integrity
- **Chunked Transfer**: 64KB chunks with individual verification
- **Cross-Platform**: Works on macOS, Windows, and Linux
- **User-Friendly**: Simple UI for non-technical users

## How It Works

1. **Sender** selects a file and generates a transfer token
2. Token is a small file (few KB) containing metadata and connection info
3. Sender emails/shares the `.ort` token file with recipient
4. **Receiver** double-clicks the token file or loads it in the app
5. Direct P2P connection established via WebRTC
6. File transfers with progress tracking and automatic resume
7. File integrity verified with cryptographic hashing

## Setup Instructions

### Prerequisites

- Node.js 18+ installed
- A VPS or server to run the signaling server (can be a cheap $5/month VPS)

### Step 1: Install Dependencies

```bash
cd orelay

# Install app dependencies
npm install

# Install server dependencies
cd server
npm install
cd ..
```

### Step 2: Deploy Signaling Server

The signaling server helps peers find each other. It needs to be publicly accessible.

#### Option A: Deploy to VPS (Recommended)

1. Copy the `server/` directory to your VPS
2. Install dependencies: `npm install`
3. Run with PM2 for auto-restart:
```bash
npm install -g pm2
pm2 start signaling-server.js --name p2p-signaling
pm2 save
pm2 startup
```

4. Configure firewall to allow port 3000 (or your chosen port)
5. Optional: Set up Nginx reverse proxy with SSL

#### Option B: Use Cloud Platform

Deploy to Heroku, Railway, Render, or similar:

1. Push `server/` directory to your cloud platform
2. Set PORT environment variable if needed
3. Note the public URL (e.g., `https://your-app.herokuapp.com`)

### Step 3: Configure App

Edit `src/renderer.js` and update the signaling server URL:

```javascript
const SIGNALING_SERVER = 'http://your-server.com:3000';
// or
const SIGNALING_SERVER = 'https://your-app.herokuapp.com';
```

### Step 4: Build the Application

Build for your platform:

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Linux
npm run build:linux

# All platforms
npm run build:all
```

Built applications will be in the `dist/` directory.

## Development

Run in development mode:

```bash
# Terminal 1: Start signaling server
cd server
npm start

# Terminal 2: Start Electron app
npm start
```

## File Association

The app registers `.ort` as its file extension. After installation:

- **macOS/Windows**: Double-click `.ort` files to open them
- **Linux**: Right-click `.ort` files and set default application

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│   Sender    │         │ Signaling Server │         │  Receiver   │
│   (Seeder)  │         │   (WebSocket)    │         │ (Downloader)│
└─────────────┘         └──────────────────┘         └─────────────┘
       │                         │                           │
       │  1. Register as peer    │                           │
       ├────────────────────────>│                           │
       │                         │   2. Register as peer     │
       │                         │<──────────────────────────┤
       │                         │                           │
       │                         │   3. Request connection   │
       │  4. Notify sender      │<──────────────────────────┤
       │<────────────────────────┤                           │
       │                         │                           │
       │  5. WebRTC handshake (SDP/ICE via signaling)       │
       │<─────────────────────────────────────────────────>│
       │                         │                           │
       │  6. Direct P2P Data Channel (WebRTC)               │
       │<═════════════════════════════════════════════════>│
       │           File chunks + hashes                     │
```

### Components

- **Electron Main Process** (`src/main.js`): Window management, file dialogs, IPC
- **Renderer Process** (`src/renderer.js`): UI logic and user interactions  
- **Transfer Manager** (`src/transfer-manager.js`): WebRTC, chunking, hashing
- **Signaling Server** (`server/signaling-server.js`): WebSocket peer discovery

### Token Format

```json
{
  "version": "1.0",
  "fileName": "video.mov",
  "fileSize": 2147483648,
  "fileHash": "sha256:abc123...",
  "senderId": "peer-id-12345",
  "signalingServer": "https://signal.example.com",
  "timestamp": 1704067200000,
  "chunkSize": 65536
}
```

Token is base64-encoded and saved as `.ort` file.

## Security Considerations

- **Encryption**: WebRTC Data Channels use DTLS encryption by default
- **Verification**: All chunks verified with SHA-256 hashes
- **No Cloud Storage**: Files never stored on intermediate servers
- **Signaling Server**: Only exchanges connection metadata, never file data

## Customization

### Change Chunk Size

Edit `src/transfer-manager.js`:
```javascript
const CHUNK_SIZE = 64 * 1024; // Change to desired size
```

Larger chunks = faster transfer, but less granular resume capability.

### Add TURN Server

For NAT traversal in restrictive networks, add TURN server to `src/transfer-manager.js`:
```javascript
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { 
    urls: 'turn:your-turn-server.com:3478',
    username: 'user',
    credential: 'pass'
  }
];
```

### Branding

- Replace icon files in `assets/` directory
- Edit app name in `package.json` `build.productName`
- Customize colors in `src/index.html` CSS

## Troubleshooting

### "Sender is not currently online"

- Sender must keep app open and running
- Check signaling server is accessible
- Verify sender's peerId matches token

### Slow Transfer Speeds

- Check network bandwidth between peers
- Increase chunk size for faster transfer
- Consider adding TURN server if behind restrictive NAT

### Connection Fails

- Verify signaling server is running and accessible
- Check firewall settings on both computers
- Try adding TURN server for NAT traversal
- Ensure both users are using same signaling server

### File Verification Failed

- Network corruption during transfer
- Transfer will automatically retry failed chunks
- Check disk space on receiver's computer

## Production Checklist

- [ ] Deploy signaling server to reliable hosting
- [ ] Use HTTPS for signaling server
- [ ] Add TURN server for enterprise networks
- [ ] Code sign the application (macOS/Windows)
- [ ] Test on all target platforms
- [ ] Create user documentation
- [ ] Set up error tracking (e.g., Sentry)
- [ ] Configure auto-updates (e.g., electron-updater)

## Technical Notes

### For Video Production Workflows

This tool is ideal for:
- Sending ProRes/RAW footage to collaborators
- Distributing final deliverables to clients
- Transferring large project files between editors

**Advantages over cloud storage:**
- No upload/download cycles (direct transfer)
- No storage costs
- Faster for large files on fast connections
- Better privacy (no third-party storage)

### NAT Traversal

WebRTC uses ICE to establish connections through NATs and firewalls:
- **STUN**: Discovers public IP address
- **TURN**: Relays data when direct connection impossible

Most residential networks work with just STUN servers. Corporate networks may require TURN.

## License

MIT License - See LICENSE file

## Support

For issues or questions, please file an issue on GitHub or contact support.

---

**Built with:** Electron, WebRTC, Socket.IO, Node.js
