// ─── Locally-minted Clerk session tokens for the test suite ──────────────────
// Clerk's verifyToken() accepts a `jwtKey` (a PEM public key) and then performs
// NO network call — that is the seam this uses. We generate an RSA pair per
// run, boot the server with the public half as CLERK_JWT_KEY, and sign our own
// RS256 tokens with the private half.
//
// The point: the REAL @clerk/backend library does the verifying. These tests
// exercise the actual signature/exp/nbf/azp checks rather than a mock that
// agrees with whatever we wrote — so a regression in how we call verifyToken is
// caught here, not in production.
//
// No new dependency: node:crypto signs RS256 directly.
import crypto from 'node:crypto';

export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Mints a token shaped like a real Clerk session token. Every claim is
// overridable so the suite can assert the failure modes (expired, not-yet-valid,
// wrong authorized party, wrong signing key).
export function mintToken(privatePem, {
  sub,
  email,
  sid = null,
  iss = process.env.CLERK_TEST_ISSUER || 'https://test.clerk.local',
  azp = process.env.CLERK_TEST_AZP || 'http://localhost',
  iat = Math.floor(Date.now() / 1000),
  nbf,
  exp,
} = {}) {
  const header = { alg: 'RS256', typ: 'JWT', kid: 'test-key' };
  const payload = {
    sub,
    sid: sid || `sess_${sub}`,
    iss,
    azp,
    iat,
    nbf: nbf ?? iat - 5,
    exp: exp ?? iat + 300,
  };
  // Clerk does not send an email claim by default — this mirrors the CUSTOM
  // session claim the deployment is expected to configure. Omit it to exercise
  // the Backend-API fallback path.
  if (email !== undefined) payload.email = email;

  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createSign('RSA-SHA256').update(data).sign(privatePem);
  return `${data}.${b64url(sig)}`;
}
