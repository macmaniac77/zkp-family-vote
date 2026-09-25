/**
 * End-to-end demo: bootstrap → invites → register → open → vote → tally
 * Run while server is up: npm run demo
 */

import {
  generateKeypair,
  signVote,
  verifyVote,
  publicKeyFromSecret,
} from './crypto.js';

const BASE = process.env.VOTE_URL || 'http://127.0.0.1:3847';

async function api(method, path, body, adminToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['x-admin-token'] = adminToken;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function main() {
  const adminToken = 'family-admin-' + Date.now().toString(36);
  console.log('Admin token (demo):', adminToken);

  const status = await api('GET', '/api/status');
  if (!status.bootstrapped) {
    await api('POST', '/api/admin/bootstrap', { adminToken });
    console.log('Bootstrapped admin');
  } else {
    console.log('Already bootstrapped — if demo fails, run: npm run reset');
    // try with provided token via env
    if (!process.env.ADMIN_TOKEN) {
      console.log('Set ADMIN_TOKEN env to your admin token, or npm run reset first');
    }
  }

  const token = process.env.ADMIN_TOKEN || adminToken;

  try {
    await api(
      'POST',
      '/api/admin/election',
      {
        title: 'Family Movie Night',
        candidates: ['Dune', 'Spirited Away', 'The Princess Bride'],
      },
      token
    );
  } catch (e) {
    if (!String(e.message).includes('already active')) throw e;
    console.log('Election already active');
  }

  const family = ['Alex', 'Sam', 'Jordan'];
  const keys = [];
  for (const name of family) {
    const inv = await api('POST', '/api/admin/invite', { label: name }, token);
    const kp = generateKeypair();
    await api('POST', '/api/register', {
      token: inv.invite.token,
      publicKey: kp.publicKey,
    });
    keys.push({ name, ...kp });
    console.log(`Registered ${name}`);
  }

  const opened = await api('POST', '/api/admin/open', {}, token);
  console.log('Voting open, ring size', opened.ring.length);

  // Each person votes — server never sees secret keys
  const choices = ['Dune', 'Spirited Away', 'Dune'];
  for (let i = 0; i < keys.length; i++) {
    const sig = signVote({
      electionId: opened.electionId,
      choice: choices[i],
      ringPublicKeys: opened.ring,
      secretKeyHex: keys[i].secretKey,
    });
    const v = verifyVote(sig);
    if (!v.ok) throw new Error('Local verify failed: ' + v.reason);
    const receipt = await api('POST', '/api/vote', { signature: sig });
    console.log(
      `${keys[i].name} voted (server does not know name) → block #${receipt.receipt.blockIndex}`
    );
  }

  // Double-vote should fail
  try {
    const sig = signVote({
      electionId: opened.electionId,
      choice: 'The Princess Bride',
      ringPublicKeys: opened.ring,
      secretKeyHex: keys[0].secretKey,
    });
    await api('POST', '/api/vote', { signature: sig });
    console.error('ERROR: double vote was accepted');
  } catch {
    console.log('Double-vote correctly rejected');
  }

  const closed = await api('POST', '/api/admin/close', {}, token);
  console.log('Tally:', closed.tally.counts);

  const chain = await api('GET', '/api/chain');
  console.log('Chain blocks:', chain.blocks.length, 'audit ok:', chain.audit.ok);
  console.log('\nDone. Open http://localhost:3847/results.html');
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
