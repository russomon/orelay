const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const io = require('socket.io-client');

const CHUNK_SIZE = 16 * 1024 * 1024; // 16MB logical chunks
const SLICE_SIZE = 16 * 1024; // 16KB slices (safe for all WebRTC implementations)
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
    this.currentPeer = null;
    
    // Receiver state
    this.receivingFile = null;
    this.receivedSize = 0;
    this.receiveBuffer = [];
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

      this.socket.on('signal', async (data) => {
        await this.handleSignal(data);
      });

      this.socket.on('error', reject);
    });
  }

  async createOffer(receiverId) {
    this.currentPeer = receiverId;

    // Create peer connection with modified configuration
    this.peerConnection = new RTCPeerConnection({
      iceServers: ICE_SERVERS
    });

    // Create data channel with optimal settings
    this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
      ordered: true,  // Maintain order
      maxRetransmits: null  // Reliable delivery
    });
    
    this.setupDataChannel();

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          to: receiverId,
          from: this.peerId,
          candidate: event.candidate
        });
      }
    };

    const offer = await this.peerConnection.createOffer();
    
    // CRITICAL: Remove Chrome's 30kbps bandwidth limit
    offer.sdp = offer.sdp.replace('b=AS:30', 'b=AS:1638400');
    
    await this.peerConnection.setLocalDescription(offer);

    this.socket.emit('signal', {
      to: receiverId,
      from: this.peerId,
      sdp: offer
    });
  }

  async handleSignal(data) {
    if (!this.peerConnection) {
      // Create peer connection as answerer
      this.currentPeer = data.from;
      this.peerConnection = new RTCPeerConnection({
        iceServers: ICE_SERVERS
      });

      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };

      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.socket.emit('signal', {
            to: data.from,
            from: this.peerId,
            candidate: event.candidate
          });
        }
      };
    }

    if (data.sdp) {
      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));

      if (data.sdp.type === 'offer') {
        const answer = await this.peerConnection.createAnswer();
        
        // CRITICAL: Remove Chrome's bandwidth limit
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

  setupDataChannel() {
    this.dataChannel.binaryType = 'arraybuffer';
    
    // CRITICAL: Set bufferedAmount threshold for flow control
    this.dataChannel.bufferedAmountLowThreshold = 256 * 1024; // 256KB threshold

    this.dataChannel.onopen = () => {
      console.log('Data channel opened');
    };

    this.dataChannel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        this.handleMessage(message);
      } else {
        this.handleBinaryData(event.data);
      }
    };

    this.dataChannel.onerror = (error) => {
      console.error('Data channel error:', error);
    };

    this.dataChannel.onclose = () => {
      console.log('Data channel closed');
    };
  }

  handleMessage(message) {
    console.log('Message received:', message.type);

    if (message.type === 'file-offer') {
      this.receiveFileOffer(message);
    } else if (message.type === 'folder-offer') {
      this.receiveFolderOffer(message);
    }
  }

  handleBinaryData(data) {
    if (!this.receivingFile) {
      console.error('Received data but no file is being received');
      return;
    }

    // Accumulate binary data
    this.receiveBuffer.push(new Uint8Array(data));
    this.receivedSize += data.byteLength;

    // Update progress
    const transfer = this.transfers.get(this.currentPeer);
    if (transfer && transfer.onProgress) {
      transfer.onProgress({
        received: this.receivedSize,
        total: this.receivingFile.size,
        percentage: Math.round((this.receivedSize / this.receivingFile.size) * 100)
      });
    }

    // Check if file is complete
    if (this.receivedSize >= this.receivingFile.size) {
      this.finalizeFileReceive();
    }
  }

  receiveFileOffer(message) {
    console.log('Receiving file offer:', message.name, message.size);
    
    this.receivingFile = {
      name: message.name,
      size: message.size,
      type: message.type
    };
    
    this.receivedSize = 0;
    this.receiveBuffer = [];

    // Accept the file
    this.dataChannel.send(JSON.stringify({ type: 'file-accepted' }));
  }

  receiveFolderOffer(message) {
    console.log('Receiving folder offer:', message.folderName, message.files.length, 'files');
    
    const transfer = {
      type: 'folder',
      token: message,
      downloadPath: null,
      currentFileIndex: 0,
      onProgress: null
    };
    
    this.transfers.set(this.currentPeer, transfer);
    
    // Accept the folder
    this.dataChannel.send(JSON.stringify({ type: 'folder-accepted' }));
  }

  finalizeFileReceive() {
    console.log('File receive complete');

    // Combine all buffers
    const completeBuffer = new Uint8Array(this.receivedSize);
    let offset = 0;
    
    for (const buffer of this.receiveBuffer) {
      completeBuffer.set(buffer, offset);
      offset += buffer.length;
    }

    // Convert to Node Buffer and save
    const fileBuffer = Buffer.from(completeBuffer);
    
    const transfer = this.transfers.get(this.currentPeer);
    const savePath = transfer.downloadPath || path.join(process.cwd(), this.receivingFile.name);
    
    fs.writeFileSync(savePath, fileBuffer);
    console.log('File saved to:', savePath);

    // Reset state
    this.receivingFile = null;
    this.receiveBuffer = [];
    this.receivedSize = 0;

    // Notify completion
    if (transfer.onComplete) {
      transfer.onComplete(savePath);
    }
  }

  async sendFile(filePath, onProgress) {
    const stats = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    
    const transfer = {
      type: 'file',
      filePath: filePath,
      size: stats.size,
      onProgress: onProgress
    };
    
    this.transfers.set(this.peerId, transfer);

    // Send file offer
    const offer = {
      type: 'file-offer',
      name: fileName,
      size: stats.size,
      type: 'application/octet-stream'
    };
    
    this.dataChannel.send(JSON.stringify(offer));

    // Wait for acceptance
    return new Promise((resolve) => {
      const checkAcceptance = (event) => {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.type === 'file-accepted') {
            this.dataChannel.removeEventListener('message', checkAcceptance);
            this.startFileSend(filePath, stats.size, onProgress, resolve);
          }
        }
      };
      
      this.dataChannel.addEventListener('message', checkAcceptance);
    });
  }

  startFileSend(filePath, fileSize, onProgress, onComplete) {
    const fileStream = fs.createReadStream(filePath, {
      highWaterMark: CHUNK_SIZE
    });

    let sentBytes = 0;

    // CRITICAL: Use event-driven flow control with bufferedAmountLow
    const sendSlice = () => {
      // Check if we can send more data
      if (this.dataChannel.bufferedAmount > this.dataChannel.bufferedAmountLowThreshold) {
        // Buffer is full, wait for it to drain
        this.dataChannel.onbufferedamountlow = () => {
          this.dataChannel.onbufferedamountlow = null;
          sendSlice();
        };
        return;
      }

      // Read next chunk
      fileStream.read(SLICE_SIZE, (err, chunk) => {
        if (err) {
          console.error('Error reading file:', err);
          fileStream.close();
          return;
        }

        if (!chunk || chunk.length === 0) {
          // File complete
          console.log('File send complete');
          fileStream.close();
          if (onComplete) onComplete();
          return;
        }

        // Send the chunk
        this.dataChannel.send(chunk);
        sentBytes += chunk.length;

        // Update progress
        if (onProgress) {
          onProgress({
            sent: sentBytes,
            total: fileSize,
            percentage: Math.round((sentBytes / fileSize) * 100)
          });
        }

        // Continue sending
        sendSlice();
      });
    };

    // Start sending
    sendSlice();
  }

  async sendFolder(folderPath, onProgress) {
    const files = await this.scanFolder(folderPath);
    const folderName = path.basename(folderPath);

    const token = {
      type: 'folder-offer',
      folderName: folderName,
      files: files.map(f => ({
        path: f.relativePath,
        size: f.size
      })),
      totalSize: files.reduce((sum, f) => sum + f.size, 0)
    };

    const transfer = {
      type: 'folder',
      folderPath: folderPath,
      files: files,
      currentFileIndex: 0,
      onProgress: onProgress
    };

    this.transfers.set(this.peerId, transfer);

    // Send folder offer
    this.dataChannel.send(JSON.stringify(token));

    // Wait for acceptance
    return new Promise((resolve) => {
      const checkAcceptance = (event) => {
        if (typeof event.data === 'string') {
          const message = JSON.parse(event.data);
          if (message.type === 'folder-accepted') {
            this.dataChannel.removeEventListener('message', checkAcceptance);
            this.startFolderSend(files, onProgress, resolve);
          }
        }
      };

      this.dataChannel.addEventListener('message', checkAcceptance);
    });
  }

  async startFolderSend(files, onProgress, onComplete) {
    let currentFileIndex = 0;
    let totalSent = 0;
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);

    const sendNextFile = async () => {
      if (currentFileIndex >= files.length) {
        console.log('Folder send complete');
        if (onComplete) onComplete();
        return;
      }

      const file = files[currentFileIndex];
      console.log(`Sending file ${currentFileIndex + 1}/${files.length}: ${file.relativePath}`);

      await this.startFileSend(file.fullPath, file.size, (progress) => {
        const overallProgress = totalSent + progress.sent;
        const overallPercentage = Math.round((overallProgress / totalSize) * 100);

        if (onProgress) {
          onProgress({
            type: 'folder',
            currentFile: currentFileIndex + 1,
            totalFiles: files.length,
            currentFileName: file.relativePath,
            fileProgress: progress.percentage,
            overallProgress: overallPercentage
          });
        }
      }, () => {
        totalSent += file.size;
        currentFileIndex++;
        sendNextFile();
      });
    };

    sendNextFile();
  }

  async scanFolder(folderPath) {
    const files = [];

    const scanDir = (dir, baseDir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          scanDir(fullPath, baseDir);
        } else {
          const stats = fs.statSync(fullPath);
          files.push({
            fullPath: fullPath,
            relativePath: path.relative(baseDir, fullPath),
            size: stats.size
          });
        }
      }
    };

    scanDir(folderPath, folderPath);
    return files;
  }

  receiveFile(downloadPath, onProgress, onComplete) {
    const transfer = {
      type: 'file',
      downloadPath: downloadPath,
      onProgress: onProgress,
      onComplete: onComplete
    };

    this.transfers.set(this.currentPeer, transfer);
  }

  receiveFolder(downloadPath, onProgress, onComplete) {
    const transfer = {
      type: 'folder',
      downloadPath: downloadPath,
      onProgress: onProgress,
      onComplete: onComplete
    };

    this.transfers.set(this.currentPeer, transfer);
  }

  disconnect() {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.peerConnection) {
      this.peerConnection.close();
    }
    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

module.exports = P2PTransferManager;
