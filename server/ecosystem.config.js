module.exports = {
  apps: [{
    name: 'orelay-relay',
    script: 'signaling-server.js',
    restart_delay: 3000,
    max_restarts: 10,
    env: {
      PORT: 3000,
      NODE_ENV: 'production'
    }
  }]
};
