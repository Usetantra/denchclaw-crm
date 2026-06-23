module.exports = {
  apps: [{
    name: 'denchclaw-crm',
    script: 'server/server.js',
    cwd: '/home/yogi/denchclaw-crm',
    env: {
      NODE_ENV: 'production',
      PORT: 3100,
      // Explicit shared-env path so the CRM finds credentials without walking up
      // the directory tree. Set to wherever automation-engines-shared/ lives on host.
      AUTOMATION_ENV_FILE: '/home/yogi/automation-engines-shared/.env.shared',
    },
    max_memory_restart: '256M',
    restart_delay: 3000,
  }],
};
