# Quick Start Guide

Get your P2P Transfer app running in 15 minutes!

## 1. Install Dependencies (5 minutes)

```bash
# Install app dependencies
cd orelay
npm install

# Install server dependencies
cd server
npm install
cd ..
```

## 2. Test Locally (5 minutes)

### Start the Signaling Server

```bash
cd server
npm start
```

You should see:
```
╔════════════════════════════════════════╗
║  P2P Transfer Signaling Server         ║
╠════════════════════════════════════════╣
║  Status: Running                       ║
║  Port: 3000                            ║
║  URL: http://localhost:3000            ║
╚════════════════════════════════════════╝
```

### Start the App

In a new terminal:
```bash
cd orelay
npm start
```

The app will launch! Try sending a file to yourself:
1. Select "Send Files"
2. Choose a test file
3. Generate token
4. Copy the token
5. Click "Back" and select "Receive Files"
6. Paste the token
7. Start download!

## 3. Deploy to Production (5 minutes)

### Deploy Signaling Server

**Option A: Quick Deploy to Railway.app (Free)**

1. Create account at [railway.app](https://railway.app)
2. Click "New Project" → "Deploy from GitHub repo"
3. Upload the `server/` folder
4. Railway auto-detects Node.js and deploys
5. Copy the public URL (e.g., `https://p2p-signal.railway.app`)

**Option B: Deploy to Your VPS**

```bash
# SSH into your VPS
ssh user@your-server.com

# Upload server folder
scp -r server/ user@your-server.com:~/p2p-server/

# On the server
cd ~/p2p-server
npm install
npm install -g pm2

# Start with PM2
pm2 start signaling-server.js --name p2p-signal
pm2 save
pm2 startup
```

### Update App Configuration

Edit `src/renderer.js` line 7:
```javascript
const SIGNALING_SERVER = 'https://your-deployed-server.com';
```

### Build the App

```bash
# For Mac
npm run build:mac

# For Windows (if on Windows)
npm run build:win

# For Linux
npm run build:linux
```

Find your built app in the `dist/` folder!

## 4. Distribute to Users

### macOS
- Package: `dist/P2P Transfer-1.0.0.dmg`
- Users drag to Applications folder
- `.ort` files will open in the app

### Windows  
- Installer: `dist/P2P Transfer Setup 1.0.0.exe`
- Users run installer
- `.ort` files will open in the app

### Linux
- Package: `dist/P2P Transfer-1.0.0.AppImage`
- Users make executable and run
- Or use `.deb` package for Debian/Ubuntu

## Common Issues

### "Cannot find module 'socket.io-client'"
```bash
npm install
```

### "Sender is not currently online"
- Make sure signaling server is running
- Update `SIGNALING_SERVER` URL in `src/renderer.js`

### App won't build
```bash
npm install electron-builder --save-dev
```

## Production Tips

1. **Use HTTPS**: Deploy signaling server with SSL certificate
2. **Monitor Server**: Use PM2 or systemd for auto-restart
3. **Add Analytics**: Track transfer success rates
4. **Brand It**: Replace icons in `assets/` folder

## Next Steps

- Read full `README.md` for advanced configuration
- Add TURN server for corporate network support
- Customize UI colors and branding
- Set up auto-updates with electron-updater

## Need Help?

- Check `README.md` for troubleshooting
- Review signaling server logs: `pm2 logs p2p-signal`
- Test connection: `curl http://your-server:3000/health`

---

**You're ready to go!** 🚀

Send your first large file without using cloud storage.
