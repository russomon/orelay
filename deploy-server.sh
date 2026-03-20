#!/bin/bash

# P2P Transfer - Server Deployment Script
# This script helps deploy the signaling server to a VPS

set -e

echo "=================================="
echo "P2P Transfer Server Deployment"
echo "=================================="
echo ""

# Check if we're on the server or local machine
if [ "$1" = "local" ]; then
    echo "Building for local deployment..."
    DEPLOY_PATH="./server"
else
    echo "This script will help you deploy to a remote server."
    echo ""
    read -p "Enter server address (e.g., user@your-server.com): " SERVER
    read -p "Enter deployment path (default: ~/p2p-server): " DEPLOY_PATH
    DEPLOY_PATH=${DEPLOY_PATH:-~/p2p-server}
    
    echo ""
    echo "Deploying to: $SERVER:$DEPLOY_PATH"
    echo ""
    read -p "Continue? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
    
    # Upload server files
    echo "Uploading files..."
    scp -r server/ $SERVER:$DEPLOY_PATH
    
    # Run setup on remote server
    echo "Installing dependencies on server..."
    ssh $SERVER << EOF
        cd $DEPLOY_PATH
        npm install
        npm install -g pm2
        
        # Stop existing process if running
        pm2 stop p2p-signal || true
        pm2 delete p2p-signal || true
        
        # Start new process
        pm2 start signaling-server.js --name p2p-signal
        pm2 save
        
        # Show status
        pm2 status
        
        echo ""
        echo "=================================="
        echo "Deployment Complete!"
        echo "=================================="
        echo ""
        echo "Server is now running on port 3000"
        echo "Make sure your firewall allows this port."
        echo ""
        echo "Useful commands:"
        echo "  pm2 status          - Check server status"
        echo "  pm2 logs p2p-signal - View logs"
        echo "  pm2 restart p2p-signal - Restart server"
        echo ""
EOF
    
    echo ""
    echo "Next steps:"
    echo "1. Configure your firewall to allow port 3000"
    echo "2. Optional: Set up Nginx reverse proxy with SSL"
    echo "3. Update SIGNALING_SERVER in src/renderer.js to your server URL"
    echo ""
fi

exit 0
