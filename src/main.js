const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

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

ipcMain.handle('save-received-file', async (event, fileName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: fileName,
    title: 'Save Received File'
  });
  
  if (!result.canceled && result.filePath) {
    return result.filePath;
  }
  return null;
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
