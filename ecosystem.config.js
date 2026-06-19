module.exports = {
  apps: [{
    name: 'denchclaw-crm',
    script: 'server/server.js',
    cwd: '/home/yogi/denchclaw-crm',
    env: {
      NODE_ENV: 'production',
      PORT: 3100,
    },
    max_memory_restart: '256M',
    restart_delay: 3000,
  }],
};
