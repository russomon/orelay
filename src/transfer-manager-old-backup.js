const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');

const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB chunks - less overhead, faster transfers
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
    this.incomingChunks = new Map(); // Map of chunkIndex -> chunk assembly data
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
      this.dataChannel = event.channel;
      this.setupDataChannel();
    };

    this.peerConnection.onconnectionstatechange = () => {
      console.log('Connection state:', this.peerConnection.connectionState);
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(this.peerConnection.connectionState);
      }
    };
  }

  setupDataChannel() {
    this.dataChannel.binaryType = 'arraybuffer';
    
    this.dataChannel.onopen = () => {
      console.log('Data channel opened');
      if (this.onChannelOpen) this.onChannelOpen();
    };

    this.dataChannel.onclose = () => {
      console.log('Data channel closed');
      if (this.onChannelClose) this.onChannelClose();
    };

    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
    };

    this.dataChannel.onmessage = (event) => {
      const size = event.data instanceof ArrayBuffer ? event.data.byteLength : event.data.length;
      console.log(`Data channel message received, type: ${typeof event.data}, size: ${size} bytes`);
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
    this.createPeerConnection();
    
    this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true
    });
    this.setupDataChannel();

    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    
    this.socket.emit('signal', {
      to: receiverId,
      from: this.peerId,
      sdp: offer
    });
  }

  handleDataChannelMessage(data) {
    try {
      // Check if data is binary (ArrayBuffer) or text (JSON)
      if (data instanceof ArrayBuffer) {
        console.log(`Binary data received: ${data.byteLength} bytes`);
        this.handleBinaryData(data);
      } else {
        // Text/JSON message
        const message = JSON.parse(data);
        console.log(`Message received, type: ${message.type}, fileIndex: ${message.fileIndex}, chunkIndex: ${message.chunkIndex}`);
        
        if (message.type === 'request-chunk') {
          this.sendChunk(message.fileIndex, message.chunkIndex);
        } else if (message.type === 'chunk-metadata') {
          this.handleChunkMetadata(message);
        } else if (message.type === 'chunk-data') {
          // Legacy base64 handling (for backward compatibility)
          this.receiveChunk(message);
        }
      }
    } catch (error) {
      console.error('Error handling message:', error);
    }
  }

  handleChunkMetadata(metadata) {
    const key = `${metadata.fileIndex}-${metadata.chunkIndex}`;
    this.incomingChunks.set(key, {
      fileIndex: metadata.fileIndex,
      chunkIndex: metadata.chunkIndex,
      totalChunks: metadata.totalChunks,
      expectedSize: metadata.size,
      hash: metadata.hash,
      parts: [],
      receivedBytes: 0
    });
    // Track which chunk we're currently receiving binary data for
    this.currentIncomingChunkKey = key;
  }

  handleBinaryData(data) {
    if (!this.currentIncomingChunkKey) {
      console.error('Received binary data without metadata');
      return;
    }
    
    const incomingChunk = this.incomingChunks.get(this.currentIncomingChunkKey);
    if (!incomingChunk) {
      console.error('Received binary data for unknown chunk:', this.currentIncomingChunkKey);
      return;
    }

    // Add this binary chunk to the parts
    incomingChunk.parts.push(new Uint8Array(data));
    incomingChunk.receivedBytes += data.byteLength;

    // Only log progress occasionally
    if (incomingChunk.parts.length % 8 === 0 || incomingChunk.receivedBytes >= incomingChunk.expectedSize) {
    }

    // Check if we've received all the data
    if (incomingChunk.receivedBytes >= incomingChunk.expectedSize) {
      // Combine all parts into one buffer
      const completeChunk = new Uint8Array(incomingChunk.expectedSize);
      let offset = 0;
      for (const part of incomingChunk.parts) {
        completeChunk.set(part, offset);
        offset += part.length;
      }

      // Convert to Node Buffer and process
      const chunkBuffer = Buffer.from(completeChunk);
      
      // Verify hash
      const calculatedHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
      if (calculatedHash !== incomingChunk.hash) {
        console.error('Chunk hash mismatch, re-requesting chunk', incomingChunk.fileIndex, incomingChunk.chunkIndex);
        
        // Remove from requested tracking so it can be re-requested
        const transfer = this.transfers.get(this.currentPeer);
        if (transfer) {
          if (transfer.type === 'folder' && transfer.requestedFiles && transfer.requestedFiles[incomingChunk.fileIndex]) {
            transfer.requestedFiles[incomingChunk.fileIndex].delete(incomingChunk.chunkIndex);
          } else if (transfer.type === 'file' && transfer.requestedChunks) {
            transfer.requestedChunks.delete(incomingChunk.chunkIndex);
          }
        }
        
        this.requestChunk(incomingChunk.fileIndex, incomingChunk.chunkIndex);
        this.incomingChunks.delete(this.currentIncomingChunkKey);
        this.currentIncomingChunkKey = null;
        return;
      }


      // Process the complete chunk
      this.processReceivedChunk({
        fileIndex: incomingChunk.fileIndex,
        chunkIndex: incomingChunk.chunkIndex,
        totalChunks: incomingChunk.totalChunks,
        chunkBuffer: chunkBuffer
      });

      // Clean up
      this.incomingChunks.delete(this.currentIncomingChunkKey);
      this.currentIncomingChunkKey = null;
    }
  }

  // FIXED: Send chunk with proper file index tracking
  sendChunk(fileIndex, chunkIndex) {
    // Initialize concurrent send tracking
    if (!this.activeSends) {
      this.activeSends = 0;
      this.MAX_CONCURRENT_SENDS = 20; // Maximum parallelism for high throughput
      this.sendQueue = [];
    }
    
    // Add to queue
    this.sendQueue.push({ fileIndex, chunkIndex });
    this.processSendQueue();
  }
  
  processSendQueue() {
    // Process queue until we hit max concurrent sends or run out of items
    while (this.activeSends < this.MAX_CONCURRENT_SENDS && this.sendQueue.length > 0) {
      this.activeSends++;
      const { fileIndex, chunkIndex } = this.sendQueue.shift();
      
      this.sendChunkInternal(fileIndex, chunkIndex, () => {
        // Callback when chunk is fully sent
        this.activeSends--;
        this.processSendQueue(); // Process next in queue
      });
    }
  }
  
  sendChunkInternal(fileIndex, chunkIndex, onComplete) {
    // Minimal logging for speed
    const transfer = this.transfers.get(this.peerId);
    if (!transfer) {
      console.error('Sender: No transfer found for peerId', this.peerId);
      onComplete();
      return;
    }

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

      // Send metadata first as JSON
      const metadata = JSON.stringify({
        type: 'chunk-metadata',
        fileIndex: fileIndex || 0,
        chunkIndex,
        totalChunks,
        size: bytesRead,
        hash: chunkHash
      });
      this.dataChannel.send(metadata);
      
      // ALWAYS split into sub-chunks - WebRTC has ~256KB message limits
      // Use 256KB for maximum throughput with safety margin
      const SUB_CHUNK_SIZE = 256 * 1024;
      let subOffset = 0;
      
      // Send all sub-chunks immediately - let WebRTC handle flow control
      while (subOffset < chunk.length) {
        const end = Math.min(subOffset + SUB_CHUNK_SIZE, chunk.length);
        const subChunk = chunk.slice(subOffset, end);
        this.dataChannel.send(subChunk);
        subOffset = end;
      }
      
      // Update progress (no logging for speed)
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
      
      // Call completion callback
      onComplete();
    } catch (error) {
      console.error('Error sending chunk:', error);
      // Send error message to receiver
      this.dataChannel.send(JSON.stringify({
        type: 'error',
        fileIndex: fileIndex,
        message: 'Failed to read file chunk'
      }));
      onComplete(); // Make sure to call onComplete even on error
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
    
    this.transfers.set(token.senderId, {
      type: 'file',
      token,
      savePath,
      totalChunks,
      receivedChunks: new Map(),
      onProgress
    });

    this.currentPeer = token.senderId;
    this.socket.emit('request-peer', {
      senderId: token.senderId,
      receiverId: this.peerId
    });

    this.onChannelOpen = () => {
      const transfer = this.transfers.get(token.senderId);
      if (!transfer.requestedChunks) {
        transfer.requestedChunks = new Set();
      }
      
      // Request first batch of chunks
      const PIPELINE_SIZE = 40;
      for (let i = 0; i < Math.min(PIPELINE_SIZE, totalChunks); i++) {
        this.requestChunk(0, i);
        transfer.requestedChunks.add(i);
      }
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
      const transfer = this.transfers.get(token.senderId);
      
      if (!transfer.requestedFiles) {
        transfer.requestedFiles = {};
      }
      if (!transfer.requestedFiles[0]) {
        transfer.requestedFiles[0] = new Set();
      }
      
      // Request first batch of chunks for first file
      const firstFileChunks = Math.ceil(token.files[0].size / CHUNK_SIZE);
      const PIPELINE_SIZE = 40;
      
      if (!transfer.chunkRequestTimes) transfer.chunkRequestTimes = {};
      if (!transfer.chunkRequestTimes[0]) transfer.chunkRequestTimes[0] = new Map();
      
      const now = Date.now();
      for (let i = 0; i < Math.min(PIPELINE_SIZE, firstFileChunks); i++) {
        this.requestChunk(0, i);
        transfer.requestedFiles[0].add(i);
        transfer.chunkRequestTimes[0].set(i, now);
      }
    };
  }

  receiveChunk(message) {
    const transfer = this.transfers.get(this.currentPeer);
    if (!transfer) {
      console.error('Receiver: No transfer found for currentPeer', this.currentPeer);
      return;
    }

    const { fileIndex, chunkIndex, data, hash, totalChunks } = message;
    const chunkBuffer = Buffer.from(data, 'base64');
    
    // Verify chunk hash
    const calculatedHash = crypto.createHash('sha256').update(chunkBuffer).digest('hex');
    if (calculatedHash !== hash) {
      console.error('Chunk hash mismatch, re-requesting chunk', fileIndex, chunkIndex);
      this.requestChunk(fileIndex, chunkIndex);
      return;
    }

    this.processReceivedChunk({ fileIndex, chunkIndex, totalChunks, chunkBuffer });
  }

  processReceivedChunk({ fileIndex, chunkIndex, totalChunks, chunkBuffer }) {
    const transfer = this.transfers.get(this.currentPeer);
    if (!transfer) return;
    
    // Pipeline constant - request this many chunks ahead
    const PIPELINE_SIZE = 40; // Increased for better throughput

    if (transfer.type === 'file') {
      // Single file handling
      transfer.receivedChunks.set(chunkIndex, chunkBuffer);

      if (transfer.onProgress) {
        transfer.onProgress({
          received: transfer.receivedChunks.size,
          total: totalChunks,
          percentage: Math.round((transfer.receivedChunks.size / totalChunks) * 100)
        });
      }

      if (transfer.receivedChunks.size < totalChunks) {
        // Request multiple chunks ahead for pipelining
        if (!transfer.requestedChunks) {
          transfer.requestedChunks = new Set();
        }
        
        // Remove this chunk from requested tracking since we received it
        transfer.requestedChunks.delete(chunkIndex);
        
        // Calculate how many chunks are currently in-flight
        const inFlight = transfer.requestedChunks.size;
        const toRequest = PIPELINE_SIZE - inFlight;
        
        // Request enough chunks to maintain PIPELINE_SIZE in-flight
        let requested = 0;
        for (let i = 0; i < totalChunks && requested < toRequest; i++) {
          if (!transfer.receivedChunks.has(i) && !transfer.requestedChunks.has(i)) {
            this.requestChunk(0, i);
            transfer.requestedChunks.add(i);
            requested++;
          }
        }
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
        
        // Write complete file
        this.writeCompletedFile(fileIndex, transfer);
        
        // Move to next file or finalize
        if (fileIndex < transfer.token.files.length - 1) {
          transfer.currentFileIndex = fileIndex + 1;
          
          // Initialize tracking for new file
          if (!transfer.requestedFiles) {
            transfer.requestedFiles = {};
          }
          if (!transfer.requestedFiles[fileIndex + 1]) {
            transfer.requestedFiles[fileIndex + 1] = new Set();
          }
          
          // Request first batch of chunks for next file
          const nextFileChunks = Math.ceil(transfer.token.files[fileIndex + 1].size / CHUNK_SIZE);
          const PIPELINE_SIZE = 40;
          
          if (!transfer.chunkRequestTimes[fileIndex + 1]) {
            transfer.chunkRequestTimes[fileIndex + 1] = new Map();
          }
          
          const now = Date.now();
          for (let i = 0; i < Math.min(PIPELINE_SIZE, nextFileChunks); i++) {
            this.requestChunk(fileIndex + 1, i);
            transfer.requestedFiles[fileIndex + 1].add(i);
            transfer.chunkRequestTimes[fileIndex + 1].set(i, now);
          }
        } else {
          this.finalizeFolderDownload(this.currentPeer);
        }
      } else {
        // Request more chunks for current file (pipelining)
        if (!transfer.requestedFiles) {
          transfer.requestedFiles = {};
        }
        if (!transfer.requestedFiles[fileIndex]) {
          transfer.requestedFiles[fileIndex] = new Set();
        }
        
        // Remove this chunk from requested tracking since we received it
        transfer.requestedFiles[fileIndex].delete(chunkIndex);
        
        // Track request times for timeout detection
        if (!transfer.chunkRequestTimes) transfer.chunkRequestTimes = {};
        if (!transfer.chunkRequestTimes[fileIndex]) transfer.chunkRequestTimes[fileIndex] = new Map();
        transfer.chunkRequestTimes[fileIndex].delete(chunkIndex);
        
        if (chunkIndex % 10 === 0) {
        }
        
        const PIPELINE_SIZE = 40;
        
        // Calculate how many chunks are currently in-flight (requested but not received)
        const inFlight = transfer.requestedFiles[fileIndex].size;
        const toRequest = PIPELINE_SIZE - inFlight;
        
        // Detect and re-request stuck chunks (in flight > 5 seconds)
        const now = Date.now();
        if (transfer.chunkRequestTimes[fileIndex]) {
          const stuckChunks = [];
          for (const [idx, time] of transfer.chunkRequestTimes[fileIndex].entries()) {
            if (now - time > 5000) {
              stuckChunks.push(idx);
            }
          }
          if (stuckChunks.length > 0) {
            console.error(`Receiver: Re-requesting ${stuckChunks.length} stuck chunks:`, stuckChunks);
            stuckChunks.forEach(idx => {
              transfer.requestedFiles[fileIndex].delete(idx);
              transfer.chunkRequestTimes[fileIndex].delete(idx);
            });
          }
        }
        
        // Only log pipeline state every 20 chunks or when there's an issue
        if (chunkIndex % 20 === 0 || toRequest > 10) {
        }
        
        // Request enough chunks to maintain PIPELINE_SIZE in-flight
        let requested = 0;
        for (let i = 0; i < fileChunks && requested < toRequest; i++) {
          if (!transfer.receivedFiles[fileIndex].has(i) && !transfer.requestedFiles[fileIndex].has(i)) {
            if (i % 10 === 0) {
            }
            this.requestChunk(fileIndex, i);
            transfer.requestedFiles[fileIndex].add(i);
            transfer.chunkRequestTimes[fileIndex].set(i, Date.now());
            requested++;
          }
        }
        
        if (requested > 0 && chunkIndex % 20 === 0) {
        }
        
        if (requested === 0 && inFlight === 0) {
          console.error(`Receiver: STALLED at file ${fileIndex}! Received: ${transfer.receivedFiles[fileIndex].size}/${fileChunks}`);
          
          // Find missing chunks
          const missing = [];
          for (let i = 0; i < fileChunks; i++) {
            if (!transfer.receivedFiles[fileIndex].has(i)) {
              missing.push(i);
            }
          }
          console.error(`Receiver: Missing chunks:`, missing);
          
          // Force re-request missing chunks
          if (missing.length > 0 && missing.length < 10) {
            console.error(`Receiver: Force re-requesting ${missing.length} missing chunks`);
            const now = Date.now();
            missing.forEach(i => {
              this.requestChunk(fileIndex, i);
              transfer.requestedFiles[fileIndex].add(i);
              transfer.chunkRequestTimes[fileIndex].set(i, now);
            });
          }
        }
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

  requestNextChunk(senderId, fileIndex, startChunk) {
    const transfer = this.transfers.get(senderId);
    if (!transfer) return;

    if (transfer.type === 'file') {
      // Find next missing chunk
      for (let i = 0; i < transfer.totalChunks; i++) {
        if (!transfer.receivedChunks.has(i)) {
          this.requestChunk(0, i);
          return;
        }
      }
    } else {
      // Find next missing chunk for current file
      const file = transfer.token.files[fileIndex];
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      
      if (!transfer.receivedFiles[fileIndex]) {
        transfer.receivedFiles[fileIndex] = new Map();
      }
      
      const start = startChunk !== undefined ? startChunk : 0;
      for (let i = start; i < totalChunks; i++) {
        if (!transfer.receivedFiles[fileIndex].has(i)) {
          this.requestChunk(fileIndex, i);
          return;
        }
      }
    }
  }

  requestChunk(fileIndex, chunkIndex) {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      console.error('Data channel not ready, cannot request chunk', fileIndex, chunkIndex);
      return;
    }
    
    this.dataChannel.send(JSON.stringify({
      type: 'request-chunk',
      fileIndex: fileIndex,
      chunkIndex: chunkIndex
    }));
  }

  async finalizeDownload(senderId) {
    const transfer = this.transfers.get(senderId);
    if (!transfer) return;

    // Write chunks to file
    const fd = fs.openSync(transfer.savePath, 'w');
    for (let i = 0; i < transfer.totalChunks; i++) {
      const chunk = transfer.receivedChunks.get(i);
      if (chunk) {
        fs.writeSync(fd, chunk);
      }
    }
    fs.closeSync(fd);

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
