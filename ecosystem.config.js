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
    // 256M was the effective capacity ceiling of the whole product: several
    // endpoints loaded every contact a tenant owned into memory, so a large
    // tenant hitting /contacts/export or /pipeline was killed mid-request rather
    // than merely being slow — taking every other in-flight request with it.
    // Those endpoints now stream or paginate (server/lib/query-limits.js), so
    // this is a genuine safety net again rather than a load-bearing limit. 768M
    // leaves room for an export batch plus normal traffic without masking a
    // real leak the way a multi-gigabyte ceiling would.
    max_memory_restart: '768M',
    restart_delay: 3000,
  }],
};
