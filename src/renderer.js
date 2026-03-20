const { ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const P2PTransferManager = require('./transfer-manager');

// Configuration
const SIGNALING_SERVER = 'http://localhost:3000'; // Change this to your server URL

let currentMode = null;
let selectedItemPath = null;
let selectedIsFolder = false;
let tokenData = null;
let transferManager = null;

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
    showSendStatus('Preparing transfer...', 'info');
    
    if (selectedIsFolder) {
      showSendStatus('Scanning folder and generating hashes...', 'info');
    }
    
    transferManager = new P2PTransferManager(SIGNALING_SERVER);
    const token = await transferManager.createTransferToken(selectedItemPath);
    
    document.getElementById('tokenDisplay').textContent = token;
    document.getElementById('sendTokenGenerated').classList.remove('hidden');
    
    // Start seeding
    await startSeeding();
    
  } catch (error) {
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
        if (selectedIsFolder) {
          showSendStatus('Recipient connected! Transferring folder...', 'info');
        } else {
          showSendStatus('Recipient connected! Transferring file...', 'info');
        }
        document.getElementById('sendProgress').classList.remove('hidden');
      } else if (state === 'disconnected') {
        showSendStatus('Recipient disconnected. Waiting for reconnection...', 'warning');
      }
    };
    
  } catch (error) {
    showSendStatus('Error starting seed: ' + error.message, 'error');
  }
}

function copyToken() {
  const token = document.getElementById('tokenDisplay').textContent;
  navigator.clipboard.writeText(token);
  showSendStatus('Token copied to clipboard!', 'success');
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
    document.getElementById('sendProgressFill').style.width = percentage + '%';
    document.getElementById('sendProgressText').textContent = 
      `${percentage}% (${progress.sent || 0}/${progress.total || 0} chunks)`;
    document.getElementById('sendCurrentFile').style.display = 'none';
    
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
  document.getElementById('sendFileSelection').classList.remove('hidden');
  document.getElementById('sendFileSelected').classList.add('hidden');
  document.getElementById('sendTokenGenerated').classList.add('hidden');
  document.getElementById('sendSeeding').classList.add('hidden');
  document.getElementById('sendProgress').classList.add('hidden');
  document.getElementById('sendStatus').classList.add('hidden');
  document.getElementById('sendProgressFill').style.width = '0%';
  document.getElementById('sendCurrentFile').style.display = 'none';
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
    
    transferManager = new P2PTransferManager(SIGNALING_SERVER);
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
    } else {
      savePath = await ipcRenderer.invoke('save-received-file', tokenData.fileName);
    }
    
    if (!savePath) return;
    
    document.getElementById('receiveProgress').classList.remove('hidden');
    showConnectionStatus('Connecting to sender...', 'connecting');
    
    const tokenString = document.getElementById('tokenInput').value.trim();
    
    await transferManager.downloadFile(tokenString, savePath, (progress) => {
      if (progress.error) {
        showReceiveStatus('Error: ' + progress.error, 'error');
      } else if (progress.complete) {
        updateReceiveProgress({ percentage: 100, verified: true });
      } else {
        updateReceiveProgress(progress);
      }
    });
    
    transferManager.onConnectionStateChange = (state) => {
      if (state === 'connected') {
        showConnectionStatus('Connected to sender', 'connected');
        if (tokenData.type === 'folder') {
          showReceiveStatus('Downloading folder...', 'info');
        } else {
          showReceiveStatus('Downloading file...', 'info');
        }
      } else if (state === 'disconnected') {
        showConnectionStatus('Disconnected', 'error');
        showReceiveStatus('Connection lost. Waiting to reconnect...', 'warning');
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
      showReceiveStatus('Download complete! All files verified successfully.', 'success');
      showConnectionStatus('Transfer complete', 'connected');
      document.getElementById('receiveCurrentFile').style.display = 'none';
      document.getElementById('receiveProgressFill').style.width = '100%';
      document.getElementById('receiveProgressText').textContent = 'Complete!';
    }
  } else {
    // Single file progress
    const percentage = progress.percentage || 0;
    document.getElementById('receiveProgressFill').style.width = percentage + '%';
    document.getElementById('receiveProgressText').textContent = 
      `${percentage}% (${progress.received || 0}/${progress.total || 0} chunks)`;
    document.getElementById('receiveCurrentFile').style.display = 'none';
    
    if (percentage === 100 && progress.verified) {
      showReceiveStatus('Download complete! File verified successfully.', 'success');
      showConnectionStatus('Transfer complete', 'connected');
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
  document.getElementById('receiveTokenInput').classList.remove('hidden');
  document.getElementById('receiveFileInfo').classList.add('hidden');
  document.getElementById('receiveProgress').classList.add('hidden');
  document.getElementById('receiveStatus').classList.add('hidden');
  document.getElementById('receiveProgressFill').style.width = '0%';
  document.getElementById('tokenInput').value = '';
  document.getElementById('receiveCurrentFile').style.display = 'none';
}

// Utility
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
