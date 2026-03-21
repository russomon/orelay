const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');

const CHUNK_SIZE = 64 * 1024; // 64KB chunks (safe with base64 encoding)
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

class P2PTransferManager {
  constructor(signalingServerUrl) {
    this.signalingServerUrl = signalingServerUrl;
    this.socket = null;
    this.peerConnection = null;
    this.dataChannel = null;
    this.peerId = this.generatePeerId();
    this.transfers = new Map();
    this.currentFileIndex = 0;
  }

  generatePeerId() {
    return crypto.randomBytes(16).toString('hex');
  }

  async connectToSignalingServer() {
    return new Promise((resolve, reject) => {
      this.socket = io(this.signalingServerUrl);
      
      this.socket.on('connect', () => {
        console.log('Connected to signaling server');
        this.socket.emit('register', this.peerId);
        resolve();
      });

      this.socket.on('connect_error', (error) => {
        reject(new Error('Failed to connect to signaling server: ' + error.message));
      });

      this.socket.on('signal', async (data) => {
        await this.handleSignal(data);
      });
    });
  }

  async handleSignal(data) {
    if (!this.peerConnection) {
      this.createPeerConnection();
    }

    if (data.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      
      if (data.sdp.type === 'offer') {
        const answer = await this.peerConnection.createAnswer();
        
        // CRITICAL FIX: Remove Chrome's 30kbps bandwidth limit
        answer.sdp = answer.sdp.replace('b=AS:30', 'b=AS:1638400');
        
        await this.peerConnection.setLocalDescription(answer);
        this.socket.emit('signal', {
          to: data.from,
          from: this.peerId,
          sdp: answer
        });
      }
    } else if (data.candidate) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  }

  createPeerConnection() {
    this.peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          to: this.currentPeer,
          from: this.peerId,
          candidate: event.candidate
        });
      }
    };

    this.peerConnection.ondatachannel = (event) => {
      console.log('Received data channel from peer');
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };

    this.peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', this.peerConnection.connectionState);
      const state = this.peerConnection.connectionState;
      if (state === 'failed') {
        console.error('Peer connection failed!');
        this.notifyTransferError('Peer connection failed');
      } else if (state === 'disconnected') {
        console.warn('Peer connection disconnected');
        this.notifyTransferError('Peer disconnected');
      }
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(state);
      }
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      console.log('ICE connection state:', this.peerConnection.iceConnectionState);
      if (this.peerConnection.iceConnectionState === 'failed') {
        console.error('ICE connection failed!');
      }
    };
  }

  setupDataChannel() {
    // CRITICAL FIX: Set binary type and flow control threshold
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256KB threshold
    
    this.dataChannel.onopen = () => {
      console.log('Data channel opened');
      if (this.onChannelOpen) this.onChannelOpen();
    };

    this.dataChannel.onclose = () => {
      console.error('Data channel closed!');
      this.notifyTransferError('Connection to peer was lost');
    };

    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
    };

    this.dataChannel.onmessage = (event) => {
      this.handleDataChannelMessage(event.data);
    };
  }

  async generateFileHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  // Recursively scan folder and get all files
  async scanFolder(folderPath) {
    const files = [];
    const skippedFiles = [];
    
    const walk = (dir) => {
      try {
        const items = fs.readdirSync(dir);
        for (const item of items) {
          // Skip hidden files and system files
          if (item.startsWith('.')) {
            console.log('Skipping hidden file:', item);
            skippedFiles.push(path.join(dir, item));
            continue;
          }
          
          const fullPath = path.join(dir, item);
          
          try {
            const stats = fs.statSync(fullPath);
            
            if (stats.isDirectory()) {
              walk(fullPath);
            } else {
              // Test if file is readable
              try {
                fs.accessSync(fullPath, fs.constants.R_OK);
                files.push({
                  fullPath: fullPath,
                  relativePath: path.relative(folderPath, fullPath),
                  size: stats.size
                });
              } catch (accessError) {
                console.log('Skipping unreadable file:', fullPath);
                skippedFiles.push(fullPath);
              }
            }
          } catch (statError) {
            console.log('Skipping inaccessible item:', fullPath);
            skippedFiles.push(fullPath);
          }
        }
      } catch (readdirError) {
        console.log('Cannot read directory:', dir);
      }
    };
    
    walk(folderPath);
    
    if (skippedFiles.length > 0) {
      console.log(`Skipped ${skippedFiles.length} files due to permissions or hidden status`);
    }
    
    return files;
  }

  // Check if path is a folder
  isFolder(itemPath) {
    try {
      return fs.statSync(itemPath).isDirectory();
    } catch (error) {
      return false;
    }
  }

  // Create token for either file or folder
  async createTransferToken(itemPath) {
    const isDir = this.isFolder(itemPath);
    
    if (isDir) {
      return await this.createFolderToken(itemPath);
    } else {
      return await this.createFileToken(itemPath);
    }
  }

  // Original single file token
  async createFileToken(filePath) {
    const stats = fs.statSync(filePath);
    const fileHash = await this.generateFileHash(filePath);
    
    const token = {
      version: '1.0',
      type: 'file',
      fileName: path.basename(filePath),
      fileSize: stats.size,
      fileHash: fileHash,
      senderId: this.peerId,
      signalingServer: this.signalingServerUrl,
      timestamp: Date.now(),
      chunkSize: CHUNK_SIZE
    };

    return Buffer.from(JSON.stringify(token)).toString('base64');
  }

  // Multi-file folder token
  async createFolderToken(folderPath) {
    console.log('Scanning folder:', folderPath);
    const files = await this.scanFolder(folderPath);
    
    if (files.length === 0) {
      throw new Error('No readable files found in folder');
    }
    
    console.log('Generating hashes for', files.length, 'files...');
    
    // Hash all files in parallel for speed
    const filePromises = files.map(async (file) => {
      try {
        const hash = await this.generateFileHash(file.fullPath);
        return {
          path: file.relativePath,
          size: file.size,
          hash: hash
        };
      } catch (error) {
        console.error('Error hashing file:', file.fullPath, error);
        return null;
      }
    });
    
    const fileMetadata = (await Promise.all(filePromises)).filter(f => f !== null);
    
    const totalSize = fileMetadata.reduce((sum, f) => sum + f.size, 0);
    
    const token = {
      version: '1.0',
      type: 'folder',
      folderName: path.basename(folderPath),
      totalSize: totalSize,
      totalFiles: fileMetadata.length,
      files: fileMetadata,
      senderId: this.peerId,
      signalingServer: this.signalingServerUrl,
      timestamp: Date.now(),
      chunkSize: CHUNK_SIZE
    };

    console.log('Token created for folder with', fileMetadata.length, 'files');
    return Buffer.from(JSON.stringify(token)).toString('base64');
  }

  parseToken(tokenString) {
    try {
      const decoded = Buffer.from(tokenString, 'base64').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      throw new Error('Invalid token format');
    }
  }

  // Seed either file or folder
  async seed(itemPath, onProgress) {
    const isDir = this.isFolder(itemPath);
    
    if (isDir) {
      const files = await this.scanFolder(itemPath);
      return await this.seedFolder(itemPath, files, onProgress);
    } else {
      return await this.seedFile(itemPath, onProgress);
    }
  }

  // Original single file seeding
  async seedFile(filePath, onProgress) {
    await this.connectToSignalingServer();
    
    const stats = fs.statSync(filePath);
    const totalChunks = Math.ceil(stats.size / CHUNK_SIZE);
    
    this.transfers.set(this.peerId, {
      type: 'file',
      filePath,
      totalChunks,
      sentChunks: 0,
      onProgress
    });

    this.socket.on('peer-requesting', async (data) => {
      if (data.senderId === this.peerId) {
        this.currentPeer = data.receiverId;
        await this.initiateConnection(data.receiverId);
      }
    });

    return this.peerId;
  }

  // Multi-file folder seeding
  async seedFolder(folderPath, files, onProgress) {
    await this.connectToSignalingServer();
    
    this.transfers.set(this.peerId, {
      type: 'folder',
      folderPath,
      files,
      currentFileIndex: 0,
      totalFiles: files.length,
      sentChunksPerFile: new Map(), // Track chunks sent per file
      onProgress
    });

    this.socket.on('peer-requesting', async (data) => {
      if (data.senderId === this.peerId) {
        this.currentPeer = data.receiverId;
        await this.initiateConnection(data.receiverId);
      }
    });

    return this.peerId;
  }

  async initiateConnection(receiverId) {
    console.log('Initiating connection to receiver:', receiverId);
    this.createPeerConnection();
    
    this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true,
      maxRetransmits: null  // Reliable delivery - no retransmit limit
    });
    
    console.log('Data channel created on sender');
    this.setupDataChannel();

    const offer = await this.peerConnection.createOffer();
    
    // CRITICAL FIX: Remove Chrome's 30kbps bandwidth limit
    offer.sdp = offer.sdp.replace('b=AS:30', 'b=AS:1638400');
    
    console.log('SDP bandwidth limit removed');
    
    await this.peerConnection.setLocalDescription(offer);
    
    this.socket.emit('signal', {
      to: receiverId,
      from: this.peerId,
      sdp: offer
    });
    
    console.log('Offer sent to receiver');
  }

  handleDataChannelMessage(data) {
    try {
      const message = JSON.parse(data);
      
      if (message.type === 'request-chunk') {
        this.sendChunk(message.fileIndex, message.chunkIndex);
      } else if (message.type === 'chunk-data') {
        this.receiveChunk(message);
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  // FIXED: Send chunk with proper file index tracking
  sendChunk(fileIndex, chunkIndex) {
    const transfer = this.transfers.get(this.peerId);
    if (!transfer) return;

    // CRITICAL FIX: Update current file index for progress display
    if (transfer.type === 'folder') {
      if (fileIndex !== transfer.currentFileIndex) {
        console.log(`Sender: Switching to file ${fileIndex + 1}/${transfer.files.length}`);
        transfer.currentFileIndex = fileIndex;
      }
      
      // Initialize chunk counter for this file if needed
      if (!transfer.sentChunksPerFile.has(fileIndex)) {
        transfer.sentChunksPerFile.set(fileIndex, 0);
      }
    }

    let filePath, totalChunks;
    
    if (transfer.type === 'file') {
      filePath = transfer.filePath;
      const stats = fs.statSync(filePath);
      totalChunks = Math.ceil(stats.size / CHUNK_SIZE);
    } else {
      // Folder - get specific file
      const file = transfer.files[fileIndex];
      filePath = file.fullPath;
      totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    }

    // Read chunk from file
    try {
      const offset = chunkIndex * CHUNK_SIZE;
      const buffer = Buffer.alloc(CHUNK_SIZE);
      
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, offset);
      fs.closeSync(fd);

      const chunk = buffer.slice(0, bytesRead);
      const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');

      this.dataChannel.send(JSON.stringify({
        type: 'chunk-data',
        fileIndex: fileIndex || 0,
        chunkIndex,
        totalChunks,
        data: chunk.toString('base64'),
        hash: chunkHash
      }));

      // Update progress
      if (transfer.type === 'file') {
        transfer.sentChunks++;
        if (transfer.onProgress) {
          transfer.onProgress({
            sent: transfer.sentChunks,
            total: totalChunks,
            percentage: Math.round((transfer.sentChunks / totalChunks) * 100)
          });
        }
      } else {
        // Folder progress
        transfer.sentChunksPerFile.set(fileIndex, transfer.sentChunksPerFile.get(fileIndex) + 1);
        
        const fileChunksSent = transfer.sentChunksPerFile.get(fileIndex);
        const fileProgress = Math.round((fileChunksSent / totalChunks) * 100);
        
        // Calculate overall progress
        let totalBytesSent = 0;
        let totalBytes = 0;
        
        for (let i = 0; i < transfer.files.length; i++) {
          const fileSize = transfer.files[i].size;
          totalBytes += fileSize;
          
          if (i < fileIndex) {
            // Files before current are complete
            totalBytesSent += fileSize;
          } else if (i === fileIndex) {
            // Current file - add chunks sent
            totalBytesSent += fileChunksSent * CHUNK_SIZE;
          }
        }
        
        const overallProgress = Math.round((totalBytesSent / totalBytes) * 100);
        
        if (transfer.onProgress) {
          transfer.onProgress({
            type: 'folder',
            currentFile: fileIndex + 1,
            totalFiles: transfer.files.length,
            currentFileName: transfer.files[fileIndex].relativePath,
            fileProgress: fileProgress,
            overallProgress: Math.min(overallProgress, 100)
          });
        }
      }
    } catch (error) {
      console.error('Error sending chunk:', error);
      // Send error message to receiver
      this.dataChannel.send(JSON.stringify({
        type: 'error',
        fileIndex: fileIndex,
        message: 'Failed to read file chunk'
      }));
    }
  }

  // Download either file or folder
  async downloadFile(tokenString, savePath, onProgress) {
    const token = this.parseToken(tokenString);
    
    this.signalingServerUrl = token.signalingServer;
    await this.connectToSignalingServer();

    if (token.type === 'file') {
      return await this.downloadSingleFile(token, savePath, onProgress);
    } else {
      return await this.downloadFolder(token, savePath, onProgress);
    }
  }

  // Original single file download
  async downloadSingleFile(token, savePath, onProgress) {
    const totalChunks = Math.ceil(token.fileSize / CHUNK_SIZE);
    const fd = fs.openSync(savePath, 'w');

    this.transfers.set(token.senderId, {
      type: 'file',
      token,
      savePath,
      totalChunks,
      receivedCount: 0,
      fd,
      onProgress
    });

    this.currentPeer = token.senderId;
    this.socket.emit('request-peer', {
      senderId: token.senderId,
      receiverId: this.peerId
    });

    this.onChannelOpen = () => {
      this.requestChunk(0, 0);
    };
  }

  // Multi-file folder download
  async downloadFolder(token, savePath, onProgress) {
    this.transfers.set(token.senderId, {
      type: 'folder',
      token,
      savePath,
      receivedFiles: {},
      currentFileIndex: 0,
      onProgress
    });

    this.currentPeer = token.senderId;
    this.socket.emit('request-peer', {
      senderId: token.senderId,
      receiverId: this.peerId
    });

    this.onChannelOpen = () => {
      console.log('Receiver: Starting download from file 0');
      this.requestChunk(0, 0);
    };
  }

  receiveChunk(message) {
    const transfer = this.transfers.get(this.currentPeer);
    if (!transfer) return;

    const { fileIndex, chunkIndex, data, hash, totalChunks } = message;
    const chunkBuffer = Buffer.from(data, 'base64');
    
    // Verify chunk hash
    const calculatedHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
    if (calculatedHash !== hash) {
      console.error('Chunk hash mismatch, re-requesting chunk', fileIndex, chunkIndex);
      this.requestChunk(fileIndex, chunkIndex);
      return;
    }

    if (transfer.type === 'file') {
      // Single file handling — write directly to disk at the correct offset
      try {
        fs.writeSync(transfer.fd, chunkBuffer, 0, chunkBuffer.length, chunkIndex * CHUNK_SIZE);
      } catch (writeError) {
        console.error('Disk write failed at chunk', chunkIndex, ':', writeError.message);
        fs.closeSync(transfer.fd);
        if (transfer.onProgress) transfer.onProgress({ error: 'Disk write failed: ' + writeError.message });
        this.cleanup();
        return;
      }
      transfer.receivedCount++;

      if (transfer.onProgress) {
        transfer.onProgress({
          received: transfer.receivedCount,
          total: totalChunks,
          percentage: Math.round((transfer.receivedCount / totalChunks) * 100)
        });
      }

      if (transfer.receivedCount < totalChunks) {
        this.requestChunk(0, chunkIndex + 1);
      } else {
        this.finalizeDownload(this.currentPeer);
      }
    } else {
      // Folder handling
      if (!transfer.receivedFiles[fileIndex]) {
        transfer.receivedFiles[fileIndex] = new Map();
      }
      transfer.receivedFiles[fileIndex].set(chunkIndex, chunkBuffer);

      const file = transfer.token.files[fileIndex];
      const fileChunks = Math.ceil(file.size / CHUNK_SIZE);

      if (transfer.onProgress) {
        transfer.onProgress({
          type: 'folder',
          currentFile: fileIndex + 1,
          totalFiles: transfer.token.files.length,
          currentFileName: file.path,
          fileProgress: Math.round((transfer.receivedFiles[fileIndex].size / fileChunks) * 100),
          received: transfer.receivedFiles[fileIndex].size,
          total: fileChunks
        });
      }

      // Check if current file is complete
      if (transfer.receivedFiles[fileIndex].size === fileChunks) {
        console.log(`Receiver: File ${fileIndex + 1}/${transfer.token.files.length} complete: ${file.path}`);
        
        // Write complete file
        this.writeCompletedFile(fileIndex, transfer);
        
        // Move to next file or finalize
        if (fileIndex < transfer.token.files.length - 1) {
          transfer.currentFileIndex = fileIndex + 1;
          console.log(`Receiver: Starting file ${fileIndex + 2}/${transfer.token.files.length}`);
          this.requestChunk(fileIndex + 1, 0);
        } else {
          this.finalizeFolderDownload(this.currentPeer);
        }
      } else {
        this.requestChunk(fileIndex, chunkIndex + 1);
      }
    }
  }

  // Write completed file to disk
  writeCompletedFile(fileIndex, transfer) {
    const file = transfer.token.files[fileIndex];
    const fullPath = path.join(transfer.savePath, file.path);
    
    try {
      // Create directories if needed
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Write file
      const fd = fs.openSync(fullPath, 'w');
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let i = 0; i < totalChunks; i++) {
        const chunk = transfer.receivedFiles[fileIndex].get(i);
        if (chunk) {
          fs.writeSync(fd, chunk);
        }
      }
      fs.closeSync(fd);
      
      console.log('File written:', fullPath);
    } catch (error) {
      console.error('Error writing file:', fullPath, error);
    }
  }

  requestChunk(fileIndex, chunkIndex) {
    this.dataChannel.send(JSON.stringify({
      type: 'request-chunk',
      fileIndex: fileIndex,
      chunkIndex: chunkIndex
    }));
  }

  async finalizeDownload(senderId) {
    const transfer = this.transfers.get(senderId);
    if (!transfer) return;

    fs.closeSync(transfer.fd);

    // Verify final file hash
    const fileHash = await this.generateFileHash(transfer.savePath);
    if (fileHash === transfer.token.fileHash) {
      console.log('File downloaded and verified successfully');
      if (transfer.onProgress) {
        transfer.onProgress({
          received: transfer.totalChunks,
          total: transfer.totalChunks,
          percentage: 100,
          verified: true
        });
      }
    } else {
      console.error('File hash verification failed');
      if (transfer.onProgress) {
        transfer.onProgress({
          error: 'File verification failed'
        });
      }
    }

    this.cleanup();
  }

  async finalizeFolderDownload(senderId) {
    const transfer = this.transfers.get(senderId);
    if (!transfer) return;

    console.log('Folder download complete, verifying files...');
    
    // Verify all files
    let allVerified = true;
    for (let i = 0; i < transfer.token.files.length; i++) {
      const file = transfer.token.files[i];
      const fullPath = path.join(transfer.savePath, file.path);
      
      try {
        const fileHash = await this.generateFileHash(fullPath);
        
        if (fileHash !== file.hash) {
          console.error('File hash verification failed:', file.path);
          allVerified = false;
        } else {
          console.log('File verified:', file.path);
        }
      } catch (error) {
        console.error('Error verifying file:', file.path, error);
        allVerified = false;
      }
    }

    if (allVerified) {
      console.log('All files downloaded and verified successfully');
      if (transfer.onProgress) {
        transfer.onProgress({
          type: 'folder',
          currentFile: transfer.token.files.length,
          totalFiles: transfer.token.files.length,
          verified: true,
          complete: true
        });
      }
    } else {
      console.error('Some files failed verification');
      if (transfer.onProgress) {
        transfer.onProgress({
          error: 'Some files failed verification'
        });
      }
    }

    this.cleanup();
  }

  notifyTransferError(message) {
    const transfer = this.transfers.get(this.currentPeer);
    if (transfer && transfer.onProgress) {
      transfer.onProgress({ error: message });
    }
    this.cleanup();
  }

  cleanup() {
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }
}

module.exports = P2PTransferManager;
