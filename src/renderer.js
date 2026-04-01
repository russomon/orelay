const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const P2PTransferManager = require('./transfer-manager');

function loadOrCreatePeerId() {
  const identityPath = path.join(os.homedir(), '.orelay', 'identity.json');
  try {
    if (fs.existsSync(identityPath)) {
      const data = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
      if (data.peerId && typeof data.peerId === 'string') return data.peerId;
    }
    const peerId = crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    fs.writeFileSync(identityPath, JSON.stringify({ peerId }));
    return peerId;
  } catch (e) {
    console.warn('Could not persist identity, using temporary peerId:', e.message);
    return crypto.randomBytes(16).toString('hex');
  }
}

const ABLY_API_KEY = '6H78zw.b03Gpg:c4v-vLqjKwfuv2RSOuN8tkrMxjEDJH8KAAkqJS6dnm8';

let currentMode = null;
let selectedItemPath = null;
let selectedIsFolder = false;
let tokenData = null;
let transferManager = null;
let transferStartTime = null;
let sendStartChunks = -1;   // chunks already sent before this session (set on first progress update)
let receiveStartTime = null;
let receiveStartChunks = 0;
let receiveLastChunks = 0;

// Right-click context menu
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  ipcRenderer.send('show-context-menu');
});

// Mode Selection
function selectMode(mode) {
  currentMode = mode;
  document.getElementById('modeSelection').classList.add('hidden');
  
  if (mode === 'send') {
    document.getElementById('sendMode').classList.remove('hidden');
  } else {
    document.getElementById('receiveMode').classList.remove('hidden');
  }
}

function backToSelection() {
  currentMode = null;
  selectedItemPath = null;
  selectedIsFolder = false;
  tokenData = null;
  
  if (transferManager) {
    transferManager.cleanup();
    transferManager = null;
  }
  
  document.getElementById('sendMode').classList.add('hidden');
  document.getElementById('receiveMode').classList.add('hidden');
  document.getElementById('modeSelection').classList.remove('hidden');
  
  resetSendUI();
  resetReceiveUI();
}

// SEND MODE FUNCTIONS
async function selectItem() {
  const result = await ipcRenderer.invoke('select-item');
  if (result) {
    selectedItemPath = result.path;
    selectedIsFolder = result.isFolder;
    
    const stats = fs.statSync(selectedItemPath);
    const itemName = path.basename(selectedItemPath);
    
    document.getElementById('sendItemName').textContent = itemName;
    
    if (selectedIsFolder) {
      // Count files in folder
      const fileCount = await countFilesInFolder(selectedItemPath);
      document.getElementById('sendItemSize').textContent = 
        `${formatFileSize(result.size)} • ${fileCount} files`;
      document.getElementById('sendItemType').textContent = '📁 Folder';
    } else {
      document.getElementById('sendItemSize').textContent = formatFileSize(stats.size);
      document.getElementById('sendItemType').textContent = '📄 File';
    }
    
    document.getElementById('sendFileSelection').classList.add('hidden');
    document.getElementById('sendFileSelected').classList.remove('hidden');
  }
}

async function countFilesInFolder(folderPath) {
  let count = 0;
  const walk = (dir) => {
    const items = fs.readdirSync(dir);
    for (const item of items) {
      const fullPath = path.join(dir, item);
      if (fs.statSync(fullPath).isDirectory()) {
        walk(fullPath);
      } else {
        count++;
      }
    }
  };
  walk(folderPath);
  return count;
}

async function generateToken() {
  try {
    document.getElementById('sendFileSelected').classList.add('hidden');
    document.getElementById('sendTokenGenerating').classList.remove('hidden');

    const fill = document.getElementById('tokenProgressFill');
    const text = document.getElementById('tokenProgressText');

    if (!selectedIsFolder) {
      // Indeterminate until first progress event arrives
      fill.classList.add('indeterminate');
      text.textContent = 'Hashing file...';
    } else {
      text.textContent = 'Scanning folder...';
    }

    transferManager = new P2PTransferManager(ABLY_API_KEY, loadOrCreatePeerId());
    const token = await transferManager.createTransferToken(selectedItemPath, (progress) => {
      if (progress.phase === 'hashing') {
        if (progress.bytes !== undefined) {
          // Single file — real byte progress
          fill.classList.remove('indeterminate');
          const pct = Math.round(progress.bytes / progress.total * 100);
          fill.style.width = pct + '%';
          text.textContent = `Hashing file... ${pct}%`;
        } else if (progress.completed !== undefined) {
          // Folder — per-file progress
          const pct = Math.round(progress.completed / progress.total * 100);
          fill.style.width = pct + '%';
          const etaStr = progress.eta != null ? ` — ${Math.ceil(progress.eta)}s remaining` : '';
          text.textContent = `Hashing file ${progress.completed} of ${progress.total}${etaStr}`;
        }
      }
    });

    document.getElementById('sendTokenGenerating').classList.add('hidden');
    document.getElementById('tokenDisplay').textContent = token;
    document.getElementById('sendTokenGenerated').classList.remove('hidden');

    await startSeeding();

  } catch (error) {
    document.getElementById('sendTokenGenerating').classList.add('hidden');
    document.getElementById('sendFileSelected').classList.remove('hidden');
    showSendStatus('Error generating token: ' + error.message, 'error');
  }
}

async function startSeeding() {
  try {
    const peerId = await transferManager.seed(selectedItemPath, (progress) => {
      updateSendProgress(progress);
    });
    
    document.getElementById('sendSeeding').classList.remove('hidden');
    
    if (selectedIsFolder) {
      showSendStatus('Ready! Send the token to your recipient. Folder will transfer when they connect.', 'success');
    } else {
      showSendStatus('Ready! Send the token to your recipient. File will transfer when they connect.', 'success');
    }
    
    // Notify main process that seeding started
    ipcRenderer.send('seeding-started', peerId);
    
    transferManager.onConnectionStateChange = (state) => {
      if (state === 'connected') {
        transferStartTime = Date.now();
        sendStartChunks = -1; // will be captured on the first progress update
        showSendStatus(selectedIsFolder ? 'Recipient connected! Transferring folder...' : 'Recipient connected! Transferring file...', 'info');
        document.getElementById('sendProgress').classList.remove('hidden');
        document.getElementById('sendTransferStats').style.display = 'block';
      } else if (state === 'disconnected') {
        showSendStatus('Connection unstable — waiting for recovery...', 'warning');
      }
    };

    
  } catch (error) {
    showSendStatus('Error starting seed: ' + error.message, 'error');
  }
}

function copyToken() {
  const token = document.getElementById('tokenDisplay').textContent;
  navigator.clipboard.writeText(token);
  const btn = document.getElementById('copyTokenBtn');
  btn.textContent = 'Copied!';
  btn.classList.add('btn-copied');
  setTimeout(() => {
    btn.textContent = 'Copy Token';
    btn.classList.remove('btn-copied');
  }, 2000);
}

async function downloadToken() {
  const token = document.getElementById('tokenDisplay').textContent;
  const itemName = path.basename(selectedItemPath);
  
  const savePath = await ipcRenderer.invoke('save-token-file', token, itemName);
  if (savePath) {
    fs.writeFileSync(savePath, token);
    showSendStatus('Token file saved! Email this to your recipient.', 'success');
  }
}

function updateSendProgress(progress) {
  if (progress.type === 'folder') {
    // Folder progress
    const overallPercentage = progress.overallProgress || 0;
    const filePercentage = progress.fileProgress || 0;
    
    document.getElementById('sendProgressFill').style.width = overallPercentage + '%';
    document.getElementById('sendProgressText').textContent = 
      `Overall: ${overallPercentage}% | File ${progress.currentFile}/${progress.totalFiles}: ${filePercentage}%`;
    document.getElementById('sendCurrentFile').textContent = 
      `Current: ${progress.currentFileName}`;
    document.getElementById('sendCurrentFile').style.display = 'block';
    
    if (overallPercentage === 100) {
      showSendStatus('Transfer complete! All files sent successfully.', 'success');
      document.getElementById('sendCurrentFile').style.display = 'none';
      setTimeout(() => {
        ipcRenderer.send('seeding-stopped', transferManager.peerId);
      }, 2000);
    }
  } else {
    // Single file progress
    const percentage = progress.percentage || 0;
    const chunksSent = progress.sent || 0;
    const bytesSent = chunksSent * 64 * 1024;
    const totalBytes = (progress.total || 0) * 64 * 1024;
    document.getElementById('sendProgressFill').style.width = percentage + '%';
    document.getElementById('sendProgressText').textContent = `${percentage}%`;
    document.getElementById('sendCurrentFile').style.display = 'none';

    // Capture the starting chunk offset the first time we get a progress update
    // (covers both fresh transfers starting at 0 and resumes starting mid-file)
    if (sendStartChunks === -1) sendStartChunks = chunksSent;

    if (transferStartTime) {
      const elapsed = (Date.now() - transferStartTime) / 1000;
      const bytesThisSession = (chunksSent - sendStartChunks) * 64 * 1024;
      const speed = elapsed > 0 ? bytesThisSession / elapsed : 0;
      const eta = speed > 0 ? (totalBytes - bytesSent) / speed : 0;
      const statsEl = document.getElementById('sendTransferStats');
      if (percentage < 100) {
        statsEl.textContent = `${formatFileSize(bytesSent)} of ${formatFileSize(totalBytes)} at ${formatFileSize(Math.round(speed))}/s — ${formatTime(eta)} remaining`;
      } else {
        statsEl.textContent = `${formatFileSize(totalBytes)} transferred in ${formatTime(elapsed)}`;
      }
    }

    if (percentage === 100) {
      showSendStatus('Transfer complete! File sent successfully.', 'success');
      setTimeout(() => {
        ipcRenderer.send('seeding-stopped', transferManager.peerId);
      }, 2000);
    }
  }
}

function showSendStatus(message, type) {
  const statusDiv = document.getElementById('sendStatusMessage');
  statusDiv.className = `status-message status-${type}`;
  statusDiv.textContent = message;
  document.getElementById('sendStatus').classList.remove('hidden');
}

function resetSendUI() {
  transferStartTime = null;
  sendStartChunks = -1;
  document.getElementById('sendFileSelection').classList.remove('hidden');
  document.getElementById('sendFileSelected').classList.add('hidden');
  document.getElementById('sendTokenGenerating').classList.add('hidden');
  document.getElementById('sendTokenGenerated').classList.add('hidden');
  document.getElementById('sendSeeding').classList.add('hidden');
  document.getElementById('sendProgress').classList.add('hidden');
  document.getElementById('sendStatus').classList.add('hidden');
  document.getElementById('sendProgressFill').style.width = '0%';
  document.getElementById('sendCurrentFile').style.display = 'none';
  document.getElementById('sendTransferStats').style.display = 'none';
}

// RECEIVE MODE FUNCTIONS
async function selectTokenFile() {
  const filePath = await ipcRenderer.invoke('select-token-file');
  if (filePath) {
    const tokenContent = fs.readFileSync(filePath, 'utf8');
    document.getElementById('tokenInput').value = tokenContent;
    await loadToken();
  }
}

async function loadToken() {
  try {
    const tokenString = document.getElementById('tokenInput').value.trim();
    if (!tokenString) {
      showReceiveStatus('Please enter a token', 'error');
      return;
    }
    
    transferManager = new P2PTransferManager(ABLY_API_KEY);
    tokenData = transferManager.parseToken(tokenString);
    
    if (tokenData.type === 'folder') {
      document.getElementById('receiveItemName').textContent = tokenData.folderName;
      document.getElementById('receiveItemSize').textContent = 
        `${formatFileSize(tokenData.totalSize)} • ${tokenData.totalFiles} files`;
      document.getElementById('receiveItemType').textContent = '📁 Folder';
    } else {
      document.getElementById('receiveItemName').textContent = tokenData.fileName;
      document.getElementById('receiveItemSize').textContent = formatFileSize(tokenData.fileSize);
      document.getElementById('receiveItemType').textContent = '📄 File';
    }
    
    document.getElementById('receiveTokenInput').classList.add('hidden');
    document.getElementById('receiveFileInfo').classList.remove('hidden');
    
    showReceiveStatus('Token loaded successfully!', 'success');
    
  } catch (error) {
    showReceiveStatus('Invalid token: ' + error.message, 'error');
  }
}

async function startDownload() {
  try {
    let savePath;
    
    if (tokenData.type === 'folder') {
      savePath = await ipcRenderer.invoke('select-folder-location', tokenData.folderName);
      if (!savePath) return;
    } else {
      const result = await ipcRenderer.invoke('save-received-file', tokenData.fileName, tokenData.fileSize);
      if (!result) return;
      savePath = result.filePath;
      if (!result.resume && fs.existsSync(savePath)) {
        fs.unlinkSync(savePath); // user chose Start Fresh — wipe the partial file
      }
    }
    
    document.getElementById('receiveProgress').classList.remove('hidden');
    showConnectionStatus('Connecting to sender...', 'connecting');

    const tokenString = document.getElementById('tokenInput').value.trim();

    let receiveComplete = false;

    ipcRenderer.send('downloading-started');

    await transferManager.downloadFile(tokenString, savePath, (progress) => {
      if (progress.error) {
        ipcRenderer.send('downloading-stopped');
        showReceiveStatus('Error: ' + progress.error, 'error');
      } else if (progress.resuming) {
        updateReceiveProgress(progress);
        showReceiveStatus(`Resuming from ${progress.percentage}% — ${formatFileSize(progress.received * 64 * 1024)} already downloaded`, 'info');
      } else if (progress.complete || (progress.percentage === 100 && progress.verified)) {
        console.log('[DIAG renderer] taking completion branch — setting receiveComplete=true');
        ipcRenderer.send('downloading-stopped');
        // Set these flags first, before any DOM work that could throw
        receiveComplete = true;
        if (transferManager) transferManager.onConnectionStateChange = null;
        try { updateReceiveProgress({ percentage: 100, received: progress.received, total: progress.total }); } catch (e) { console.warn('[DIAG renderer] updateReceiveProgress error:', e); }
        showReceiveStatus(`Transfer complete. File saved to "${savePath}"`, 'success');
        showConnectionStatus('Transfer complete', 'connected');
        console.log('[DIAG renderer] completion branch done');
      } else {
        updateReceiveProgress(progress);
      }
    });

    console.log('[DIAG renderer] downloadFile awaited — assigning onConnectionStateChange');
    transferManager.onConnectionStateChange = (state) => {
      console.log('[DIAG renderer] onConnectionStateChange fired, state:', state, '| receiveComplete:', receiveComplete);
      if (receiveComplete) return;
      if (state === 'connected') {
        receiveStartTime = Date.now();
        receiveStartChunks = receiveLastChunks;
        showConnectionStatus('Connected to sender', 'connected');
        if (tokenData.type === 'folder') {
          showReceiveStatus('Downloading folder...', 'info');
        } else {
          showReceiveStatus('Downloading file...', 'info');
        }
      } else if (state === 'disconnected') {
        showConnectionStatus('Reconnecting...', 'connecting');
      }
    };
    
  } catch (error) {
    showReceiveStatus('Error starting download: ' + error.message, 'error');
  }
}

function updateReceiveProgress(progress) {
  if (progress.type === 'folder') {
    // Folder progress
    const filePercentage = progress.fileProgress || 0;
    
    document.getElementById('receiveProgressFill').style.width = filePercentage + '%';
    document.getElementById('receiveProgressText').textContent = 
      `File ${progress.currentFile}/${progress.totalFiles}: ${filePercentage}%`;
    document.getElementById('receiveCurrentFile').textContent = 
      `Downloading: ${progress.currentFileName}`;
    document.getElementById('receiveCurrentFile').style.display = 'block';
    
    if (progress.verified) {
      document.getElementById('receiveCurrentFile').style.display = 'none';
      document.getElementById('receiveProgressFill').style.width = '100%';
      document.getElementById('receiveProgressText').textContent = 'Complete!';
    }
  } else {
    // Single file progress
    const percentage = progress.percentage || 0;
    receiveLastChunks = progress.received || 0;
    const bytesReceived = receiveLastChunks * 64 * 1024;
    const totalBytes = (progress.total || 0) * 64 * 1024;

    document.getElementById('receiveProgressFill').style.width = percentage + '%';
    document.getElementById('receiveProgressText').textContent = `${percentage}%`;
    document.getElementById('receiveCurrentFile').style.display = 'none';

    const statsEl = document.getElementById('receiveTransferStats');
    if (receiveStartTime && percentage < 100) {
      const elapsed = (Date.now() - receiveStartTime) / 1000;
      const bytesThisSession = (receiveLastChunks - receiveStartChunks) * 64 * 1024;
      const speed = elapsed > 0 ? bytesThisSession / elapsed : 0;
      const eta = speed > 0 ? (totalBytes - bytesReceived) / speed : 0;
      statsEl.style.display = 'block';
      statsEl.textContent = `${formatFileSize(bytesReceived)} of ${formatFileSize(totalBytes)} at ${formatFileSize(Math.round(speed))}/s — ${formatTime(eta)} remaining`;
    } else if (percentage === 100) {
      statsEl.style.display = 'none';
    }

  }
}

function showConnectionStatus(message, type) {
  const statusDiv = document.getElementById('receiveConnectionStatus');
  statusDiv.className = `connection-status ${type}`;
  statusDiv.textContent = message;
}

function showReceiveStatus(message, type) {
  const statusDiv = document.getElementById('receiveStatusMessage');
  statusDiv.className = `status-message status-${type}`;
  statusDiv.textContent = message;
  document.getElementById('receiveStatus').classList.remove('hidden');
}

function resetReceiveUI() {
  receiveStartTime = null;
  receiveStartChunks = 0;
  receiveLastChunks = 0;
  document.getElementById('receiveTokenInput').classList.remove('hidden');
  document.getElementById('receiveFileInfo').classList.add('hidden');
  document.getElementById('receiveProgress').classList.add('hidden');
  document.getElementById('receiveStatus').classList.add('hidden');
  document.getElementById('receiveProgressFill').style.width = '0%';
  document.getElementById('tokenInput').value = '';
  document.getElementById('receiveCurrentFile').style.display = 'none';
  document.getElementById('receiveTransferStats').style.display = 'none';
}

// Utility
function formatTime(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Handle file association - when user double-clicks .ort file
ipcRenderer.on('open-token-file', async (event, filePath) => {
  if (currentMode !== 'receive') {
    selectMode('receive');
  }
  
  const tokenContent = fs.readFileSync(filePath, 'utf8');
  document.getElementById('tokenInput').value = tokenContent;
  await loadToken();
});

// Expose functions to window for HTML onclick handlers
window.selectMode = selectMode;
window.backToSelection = backToSelection;
window.selectItem = selectItem;
window.generateToken = generateToken;
window.copyToken = copyToken;
window.downloadToken = downloadToken;
window.selectTokenFile = selectTokenFile;
window.loadToken = loadToken;
window.startDownload = startDownload;
