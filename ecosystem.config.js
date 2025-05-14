module.exports = {
  apps: [{
    name: 'Delta-AI',
    script: 'server.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production'
    },
    exp_backoff_restart_delay: 100
  }]
};