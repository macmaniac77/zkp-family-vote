/**
 * Tests offline ballot package path against a running server.
 */
import { generateKeypair, signVote, verifyVote, sha256Hex } from './crypto.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = process.env.VOTE_URL || 'http://127.0.0.1:3847';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function api(method, p, body, adminToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['x-admin-token'] = adminToken;
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

const adminToken = 'offline-test-' + Date.now().toString(36);
const status = await api('GET', '/api/status');
if (!status.bootstrapped) {
  await api('POST', '/api/admin/bootstrap', { adminToken });
} else {
  console.log('Server already bootstrapped; run npm run reset if this fails');
}
const token = status.bootstrapped ? process.env.ADMIN_TOKEN : adminToken;
if (status.bootstrapped && !process.env.ADMIN_TOKEN) {
  // fresh reset should have been done
}

const t = process.env.ADMIN_TOKEN || adminToken;
try {
  await api('POST', '/api/admin/election', {
    title: 'Offline Sign Test',
    candidates: ['Aye', 'Nay'],
  }, t);
} catch (e) {
  if (!String(e.message).includes('already')) throw e;
}

const kp = generateKeypair();
const inv = await api('POST', '/api/admin/invite', { label: 'OfflineVoter' }, t);
await api('POST', '/api/register', { token: inv.invite.token, publicKey: kp.publicKey });
const opened = await api('POST', '/api/admin/open', {}, t);

// Simulate offline context pack
const packRes = await fetch(`${BASE}/api/vote/offline-pack`);
const pack = await packRes.json();
if (!packRes.ok) throw new Error(pack.error);
console.log('offline pack contextHash', pack.contextHash);

// Client-side equivalent of buildOfflineBallot
const signature = signVote({
  electionId: pack.electionId,
  choice: 'Aye',
  ringPublicKeys: pack.ring,
  secretKeyHex: kp.secretKey,
});
const ballot = {
  type: 'zkp-family-vote-ballot',
  version: 1,
  contextHash: pack.contextHash,
  messageHash: sha256Hex(signature.message),
  message: signature.message,
  signedAt: new Date().toISOString(),
  signature: {
    electionId: signature.electionId,
    choice: signature.choice,
    keyImage: signature.keyImage,
    c0: signature.c0,
    s: signature.s,
    ring: signature.ring,
    message: signature.message,
  },
};

// Ensure secret not in package
const raw = JSON.stringify(ballot);
if (raw.includes(kp.secretKey)) throw new Error('SECRET LEAKED INTO BALLOT PACKAGE');
console.log('secret not in ballot package: ok');
console.log('local verify:', verifyVote(ballot.signature).ok);
console.log('messageHash:', ballot.messageHash.slice(0, 24) + '…');

const receipt = await api('POST', '/api/vote', { signature: ballot.signature });
console.log('submitted block', receipt.receipt.blockIndex);

const out = path.join(__dirname, '..', 'data', 'sample-offline-ballot.json');
fs.writeFileSync(out, JSON.stringify(ballot, null, 2));
console.log('wrote', out);
console.log('PASS');
