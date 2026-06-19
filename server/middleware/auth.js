'use strict';
const { v4: uuidv4 } = require('uuid');

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || (() => {
  const k = 'denchclaw-dev-' + uuidv4();
  console.warn('[Auth] INTERNAL_API_KEY not set — ephemeral dev key generated:', k);
  return k;
})();

const ALLOWED_CIDRS = (process.env.INTERNAL_API_ALLOWED_CIDRS || '127.0.0.1/32,::1/128')
  .split(',').map(s => s.trim()).filter(Boolean);

function ipAllowed(ip) {
  if (!ip || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;
  return ALLOWED_CIDRS.some(cidr => {
    const [base] = cidr.split('/');
    return ip === base || ip.startsWith(base.replace(/\.\d+$/, '.'));
  });
}

function requireAuth(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Missing or invalid X-Internal-Key' });
  }
  const callerIp = req.ip || req.socket?.remoteAddress || '';
  if (!ipAllowed(callerIp)) {
    console.warn('[Auth] X-Internal-Key rejected from IP:', callerIp);
    return res.status(403).json({ error: 'Internal API access denied from this address' });
  }
  req.auth = {
    userId: 'internal-agent',
    companyId: req.headers['x-company-id'] || 'growthclub',
    role: 'agent',
  };
  next();
}

function getUserCompanyId(req) {
  return req.auth?.companyId || null;
}

module.exports = { requireAuth, getUserCompanyId, INTERNAL_API_KEY };
