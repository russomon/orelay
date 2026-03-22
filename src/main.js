const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// Suppress Chromium's verbose WebRTC/STUN logging (EAGAIN errors under load are harmless)
app.commandLine.appendSwitch('log-level', '3');

let mainWindow;
let seedingWindows = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.loadFile('src/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function handleFileOpen(filePath) {
  if (filePath.endsWith('.ort')) {
    if (!mainWindow) {
      createWindow();
    }
    
    mainWindow.webContents.on('did-finish-load', () => {
      mainWindow.webContents.send('open-token-file', filePath);
    });
    
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  handleFileOpen(filePath);
});

app.whenReady().then(() => {
  createWindow();

  if (process.platform === 'win32' && process.argv.length >= 2) {
    const filePath = process.argv[1];
    if (filePath && filePath.endsWith('.ort')) {
      handleFileOpen(filePath);
    }
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// NEW: Select file or folder
ipcMain.handle('select-item', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'openDirectory'],
    title: 'Select File or Folder to Send'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    const itemPath = result.filePaths[0];
    const stats = fs.statSync(itemPath);
    const isFolder = stats.isDirectory();
    
    let totalSize = stats.size;
    if (isFolder) {
      totalSize = getFolderSize(itemPath);
    }
    
    return {
      path: itemPath,
      isFolder: isFolder,
      size: totalSize
    };
  }
  return null;
});

// Helper function to calculate folder size
function getFolderSize(folderPath) {
  let totalSize = 0;
  
  const walk = (dir) => {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        walk(filePath);
      } else {
        totalSize += stats.size;
      }
    }
  };
  
  walk(folderPath);
  return totalSize;
}

ipcMain.handle('select-token-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Orelay Token', extensions: ['ort'] }
    ],
    title: 'Select Transfer Token'
  });
  
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('save-token-file', async (event, tokenData, fileName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `transfer-${fileName}.ort`,
    filters: [
      { name: 'Orelay Token', extensions: ['ort'] }
    ]
  });
  
  if (!result.canceled && result.filePath) {
    return result.filePath;
  }
  return null;
});

ipcMain.handle('save-received-file', async (event, fileName, totalSize) => {
  // Use openDirectory instead of showSaveDialog so the OS never shows its
  // own "Replace?" sheet — we construct the save path and handle conflicts ourselves.
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: `Choose where to save "${fileName}"`
  });

  if (result.canceled || !result.filePaths.length) return null;

  const filePath = path.join(result.filePaths[0], fileName);

  if (fs.existsSync(filePath)) {
    const existingSize = fs.statSync(filePath).size;
    const fmt = (bytes) => {
      if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
      if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
      return Math.round(bytes / 1024) + ' KB';
    };
    const pct = totalSize > 0 ? Math.round(existingSize / totalSize * 100) : 0;
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'question',
      buttons: ['Resume Download', 'Start Fresh', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Partial Download Found',
      message: `"${fileName}" is partially downloaded`,
      detail: `${fmt(existingSize)} of ${fmt(totalSize)} (${pct}%) already downloaded.\n\nResume to continue where you left off, or Start Fresh to download again from the beginning.`
    });
    if (choice === 2) return null;
    return { filePath, resume: choice === 0 };
  }

  return { filePath, resume: false };
});

// FIXED: Select folder location for received folder
ipcMain.handle('select-folder-location', async (event, folderName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: folderName,
    title: `Select location to save folder: ${folderName}`,
    buttonLabel: 'Save',
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });
  
  if (!result.canceled && result.filePath) {
    // Return the complete path
    console.log('Selected save path:', result.filePath);
    return result.filePath;
  }
  return null;
});

ipcMain.on('seeding-started', (event, peerId) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    seedingWindows.set(peerId, window);
    
    window.on('close', (e) => {
      if (seedingWindows.has(peerId)) {
        e.preventDefault();
        const choice = dialog.showMessageBoxSync(window, {
          type: 'warning',
          buttons: ['Cancel', 'Stop Seeding and Close'],
          title: 'File Transfer in Progress',
          message: 'You are currently seeding a file. Closing will prevent recipients from downloading.',
          defaultId: 0,
          cancelId: 0
        });
        
        if (choice === 1) {
          seedingWindows.delete(peerId);
          window.destroy();
        }
      }
    });
  }
});

ipcMain.on('seeding-stopped', (event, peerId) => {
  seedingWindows.delete(peerId);
});

ipcMain.on('show-context-menu', (event) => {
  const menu = Menu.buildFromTemplate([
    { label: 'Copy', role: 'copy' },
    { label: 'Paste', role: 'paste' },
    { type: 'separator' },
    { label: 'Select All', role: 'selectAll' }
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});
