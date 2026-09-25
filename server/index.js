/**
 * ZKP Family Vote — single-server API
 * Secrets never land on the vote chain: only key images + choices + ring proofs.
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { Store } from './store.js';
import { VoteChain } from './chain.js';
import { verifyVote, safeEqual, sha256Hex } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

const store = new Store(path.join(DATA, 'state.json'));
const chain = new VoteChain(path.join(DATA, 'blockchain.jsonl'));

const app = express();
app.use(express.json({ limit: '512kb' }));
// Noble crypto for browser (offline-capable once cached; no CDN)
app.use(
  '/vendor/@noble/curves',
  express.static(path.join(ROOT, 'node_modules', '@noble', 'curves'), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  })
);
app.use(
  '/vendor/@noble/hashes',
  express.static(path.join(ROOT, 'node_modules', '@noble', 'hashes'), {
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    },
  })
);
app.use(express.static(path.join(ROOT, 'public')));

function adminAuth(req, res, next) {
  const token = req.header('x-admin-token') || req.body?.adminToken || '';
  if (!store.checkAdmin(token)) {
    return res.status(401).json({ error: 'Unauthorized — bad admin token' });
  }
  next();
}

function err(res, e, code = 400) {
  return res.status(code).json({ error: e.message || String(e) });
}

// ---------- Public ----------

app.get('/api/status', (_req, res) => {
  res.json({
    ...store.getPublicSnapshot(),
    chain: {
      length: chain.blocks.length,
      tip: chain.tip().hash,
      file: 'data/blockchain.jsonl',
    },
  });
});

app.get('/api/chain', (_req, res) => {
  res.json({
    blocks: chain.all(),
    audit: chain.audit(),
  });
});

app.get('/api/chain/audit', (_req, res) => {
  res.json(chain.audit());
});

app.get('/api/tally', (_req, res) => {
  const election = store.getElection();
  if (!election) return res.json({ election: null, tally: null });
  const tally = chain.tally(election.id, election.candidates);
  res.json({
    election: {
      id: election.id,
      title: election.title,
      status: election.status,
      candidates: election.candidates,
    },
    tally,
    // Individual ballots are public (anonymous); linkage to people is not.
    ballots: chain.votesForElection(election.id).map((b) => ({
      index: b.index,
      timestamp: b.timestamp,
      choice: b.payload.choice,
      keyImage: b.payload.keyImage,
      hash: b.hash,
      verified: true,
    })),
  });
});

app.get('/api/invite/:token', (req, res) => {
  const token = (req.params.token || '').trim();
  if (!token || token === 'undefined' || token === 'null') {
    return res.status(400).json({
      error: 'No invite token provided',
      hint: 'Paste the full invite link from Admin, or the long hex token after invite=',
    });
  }
  const info = store.peekInvite(token);
  if (!info) {
    const e = store.getElection();
    return res.status(404).json({
      error: 'Invite not found',
      hint: e
        ? e.status !== 'registration'
          ? `Election is "${e.status}" — invites only work during registration. Ask admin to create invites before opening voting.`
          : 'Ask Admin to click “Generate invite”, copy the link, and send it to you. Empty field / wrong paste will always fail. Invites are single-use and shown only once.'
        : 'No election exists yet. Admin must create an election and generate invites first.',
      electionStatus: e?.status || null,
      inviteCount: e ? store.getPublicSnapshot().election?.inviteCount : 0,
    });
  }
  res.json(info);
});

app.post('/api/register', (req, res) => {
  try {
    const { token, publicKey } = req.body || {};
    const result = store.registerVoter({ token, publicKey });
    const block = chain.append('registration', {
      electionId: result.electionId,
      // Only public key — never the secret, never the invite token
      publicKey: result.publicKey,
      // label is NOT written to chain (would aid linkage if combined with timing)
      note: 'Voter public key enrolled; secret key never leaves the voter device',
    });
    res.json({ ...result, chainBlock: block.index, chainHash: block.hash });
  } catch (e) {
    err(res, e);
  }
});

app.get('/api/vote/context', (_req, res) => {
  const election = store.getElection();
  if (!election) return res.status(404).json({ error: 'No election' });
  if (election.status !== 'open') {
    return res.status(400).json({
      error: `Voting is not open (status: ${election.status})`,
      status: election.status,
    });
  }
  const ring = store.getFrozenRing();
  res.json({
    electionId: election.id,
    title: election.title,
    candidates: election.candidates,
    ring,
    ringSize: ring.length,
  });
});

/**
 * Downloadable offline signing pack (public data only).
 * Take this file + your secret offline → produce a ballot package → submit later.
 */
app.get('/api/vote/offline-pack', (_req, res) => {
  const election = store.getElection();
  if (!election) return res.status(404).json({ error: 'No election' });
  if (election.status !== 'open') {
    return res.status(400).json({
      error: `Voting is not open (status: ${election.status})`,
      status: election.status,
    });
  }
  const ring = store.getFrozenRing();
  if (!ring?.length) return res.status(400).json({ error: 'Ring not frozen' });

  const pack = {
    type: 'zkp-family-vote-offline-context',
    version: 1,
    title: election.title,
    electionId: election.id,
    candidates: [...election.candidates],
    ring: [...ring],
    ringSize: ring.length,
    downloadedAt: new Date().toISOString(),
  };
  // Same canonical hash as client contextHash()
  const canonical = JSON.stringify({
    electionId: pack.electionId,
    candidates: pack.candidates,
    ring: pack.ring,
  });
  pack.contextHash = sha256Hex(canonical);
  pack.howto = [
    '1. Keep this file offline with your secret key (never email the secret).',
    '2. Open /offline.html (works from cache if you visited while online).',
    '3. Load this pack + unlock your key → pick choice → export ballot JSON.',
    '4. Go online and submit the ballot JSON on /vote.html (secret is not in the file).',
  ];
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="offline-context-${election.id}.json"`
  );
  res.json(pack);
});

/**
 * Client builds the ring signature in the browser (or via demo script).
 * Server only verifies — it never receives the secret key.
 */
app.post('/api/vote', (req, res) => {
  try {
    const election = store.getElection();
    if (!election) throw new Error('No election');
    if (election.status !== 'open') {
      throw new Error(`Voting is not open (status: ${election.status})`);
    }

    const sig = req.body?.signature;
    if (!sig) throw new Error('Missing signature');

    // Must use frozen ring exactly
    const ring = store.getFrozenRing();
    if (!ring?.length) throw new Error('Voter ring not frozen');
    if (!Array.isArray(sig.ring) || sig.ring.length !== ring.length) {
      throw new Error('Ring does not match frozen roster');
    }
    for (let i = 0; i < ring.length; i++) {
      if (sig.ring[i] !== ring[i]) {
        throw new Error('Ring public keys do not match frozen roster order');
      }
    }

    if (!election.candidates.includes(sig.choice)) {
      throw new Error('Invalid candidate choice');
    }
    if (sig.electionId !== election.id) {
      throw new Error('Wrong election id');
    }

    const check = verifyVote(sig);
    if (!check.ok) throw new Error(check.reason || 'Invalid proof');

    const used = chain.keyImagesForElection(election.id);
    if (used.has(sig.keyImage)) {
      throw new Error('This voter has already cast a ballot (key image seen)');
    }

    // Persist ONLY public ballot material — no names, no secrets
    const block = chain.append('vote', {
      electionId: election.id,
      choice: sig.choice,
      keyImage: sig.keyImage,
      proof: {
        scheme: 'lsag-secp256k1',
        c0: sig.c0,
        s: sig.s,
        ringHash: sha256Hex(ring.join('|')),
        // full ring stored so auditors can re-verify without server state
        ring: sig.ring,
      },
      message: sig.message,
    });

    res.json({
      ok: true,
      // Receipt for the voter — proves inclusion without revealing identity
      receipt: {
        blockIndex: block.index,
        blockHash: block.hash,
        keyImage: sig.keyImage,
        choice: sig.choice,
        timestamp: block.timestamp,
        prevHash: block.prevHash,
      },
    });
  } catch (e) {
    err(res, e);
  }
});

// ---------- Admin ----------

app.post('/api/admin/bootstrap', (req, res) => {
  try {
    const { adminToken } = req.body || {};
    if (!adminToken || adminToken.length < 8) {
      throw new Error('Admin token must be at least 8 characters');
    }
    store.bootstrapAdmin(adminToken);
    const block = chain.append('admin_bootstrap', {
      note: 'Admin initialized (token hash only; raw token never stored)',
    });
    res.json({ ok: true, chainBlock: block.index });
  } catch (e) {
    err(res, e);
  }
});

app.get('/api/admin/dashboard', adminAuth, (_req, res) => {
  res.json({
    ...store.getAdminSnapshot(),
    chainAudit: chain.audit(),
    votesCast: store.getElection()
      ? chain.votesForElection(store.getElection().id).length
      : 0,
  });
});

app.post('/api/admin/election', adminAuth, (req, res) => {
  try {
    const { title, candidates } = req.body || {};
    const election = store.createElection({ title, candidates });
    const block = chain.append('election_created', {
      electionId: election.id,
      title: election.title,
      candidates: election.candidates,
    });
    res.json({ election, chainBlock: block.index });
  } catch (e) {
    err(res, e);
  }
});

app.post('/api/admin/invite', adminAuth, (req, res) => {
  try {
    const { label } = req.body || {};
    const invite = store.createInvite(label);
    // Invite token returned once to admin to share out-of-band
    res.json({
      invite: {
        id: invite.id,
        label: invite.label,
        token: invite.token,
        urlPath: `/voter.html?invite=${invite.token}`,
      },
      warning: 'Copy this invite now. The server does not store the raw token.',
    });
  } catch (e) {
    err(res, e);
  }
});

app.post('/api/admin/open', adminAuth, (req, res) => {
  try {
    const opened = store.openVoting();
    const block = chain.append('voting_opened', {
      electionId: opened.electionId,
      ringSize: opened.ring.length,
      ringHash: sha256Hex(opened.ring.join('|')),
      candidates: opened.candidates,
    });
    res.json({ ...opened, chainBlock: block.index });
  } catch (e) {
    err(res, e);
  }
});

app.post('/api/admin/close', adminAuth, (req, res) => {
  try {
    const election = store.closeVoting();
    const tally = chain.tally(election.id, election.candidates);
    const block = chain.append('voting_closed', {
      electionId: election.id,
      tally,
    });
    res.json({ election, tally, chainBlock: block.index });
  } catch (e) {
    err(res, e);
  }
});

// HTML pages only — never fall back to index.html for /vendor or missing .js
// (that was breaking noble ESM: @noble/hashes/utils resolved to HTML)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (req.path.startsWith('/vendor/')) {
    return res.status(404).type('text/plain').send('Vendor module not found: ' + req.path);
  }
  // Known app routes
  const page = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  const candidate = path.join(ROOT, 'public', page);
  if (page.endsWith('.html') || page === 'index.html') {
    return res.sendFile(candidate, (e) => {
      if (e) res.status(404).send('Page not found');
    });
  }
  // Static middleware already tried; do not HTML-fallback assets
  res.status(404).type('text/plain').send('Not found');
});

const PORT = process.env.PORT || 3847;
app.listen(PORT, () => {
  console.log(`\n  ZKP Family Vote  →  http://localhost:${PORT}`);
  console.log(`  Chain file       →  ${path.join(DATA, 'blockchain.jsonl')}`);
  console.log(`  State file       →  ${path.join(DATA, 'state.json')}\n`);
});
