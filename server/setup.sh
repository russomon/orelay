#!/bin/bash
# Orelay relay server setup script for Oracle Cloud (Ubuntu/Debian)
# Run this on the VM after SSH-ing in: bash setup.sh

set -e

echo "=== Installing Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Installing PM2 ==="
sudo npm install -g pm2

echo "=== Installing dependencies ==="
npm install --production

echo "=== Starting relay server ==="
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | sudo bash

echo "=== Opening port 3000 in OS firewall ==="
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables-save | sudo tee /etc/iptables/rules.v4 > /dev/null || \
  sudo sh -c "iptables-save > /etc/iptables.rules"

echo ""
echo "=== Done! Relay server is running. ==="
pm2 status
