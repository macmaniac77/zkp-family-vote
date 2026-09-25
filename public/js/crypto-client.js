/**
 * Browser crypto for Family ZKP Vote
 * ----------------------------------
 * Key creation · encrypted storage · offline ballot signing
 * Secret keys never leave the device except via user export.
 *
 * Serves from local /vendor paths so the offline signer can work
 * without CDN when the page + assets are cached.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  concatBytes,
} from '@noble/hashes/utils.js';

const Point = secp256k1.ProjectivePoint;
const CURVE_ORDER = secp256k1.CURVE.n;
const G = Point.BASE;

const IDENTITY_KEY = 'zkp_family_vote_identity';
const VAULT_KEY = 'zkp_family_vote_vault';
const PBKDF2_ITERATIONS = 210_000;

// ─── primitives ───────────────────────────────────────────────

function modN(x) {
  let v = x % CURVE_ORDER;
  if (v < 0n) v += CURVE_ORDER;
  return v;
}

function bytesToScalar(bytes) {
  const h = sha256(bytes);
  let x = 0n;
  for (const b of h) x = (x << 8n) | BigInt(b);
  return modN(x);
}

function scalarToBytes(scalar) {
  let x = modN(scalar);
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function scalarToHex(scalar) {
  return bytesToHex(scalarToBytes(scalar));
}

function hexToScalar(hex) {
  const b = hexToBytes(String(hex).replace(/^0x/, '').trim());
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return modN(x);
}

export function sha256Hex(data) {
  const bytes =
    typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return bytesToHex(sha256(bytes));
}

function hashToPoint(data) {
  const seed = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  for (let i = 0; i < 256; i++) {
    const candidate = sha256(concatBytes(seed, Uint8Array.of(i)));
    const compressed = new Uint8Array(33);
    compressed[0] = 0x02;
    compressed.set(candidate, 1);
    try {
      return Point.fromHex(bytesToHex(compressed));
    } catch {
      compressed[0] = 0x03;
      try {
        return Point.fromHex(bytesToHex(compressed));
      } catch {
        /* continue */
      }
    }
  }
  throw new Error('hashToPoint failed');
}

function challengeHash(message, L, R) {
  return bytesToScalar(
    sha256(
      concatBytes(
        new TextEncoder().encode(message),
        hexToBytes(L.toHex(true)),
        hexToBytes(R.toHex(true))
      )
    )
  );
}

function randomSalt(len = 16) {
  return bytesToHex(randomBytes(len));
}

// ─── Key creation methods ─────────────────────────────────────

/**
 * Method A — pure entropy (recommended default).
 * Uses CSPRNG; secret is independent of any passphrase.
 */
export function generateKeypair() {
  let sk = bytesToScalar(randomBytes(32));
  if (sk === 0n) sk = 1n;
  return {
    method: 'random',
    secretKey: scalarToHex(sk),
    publicKey: G.multiply(sk).toHex(true),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Method B — passphrase-derived key (recoverable if you remember the phrase + salt).
 * PBKDF2-HMAC-SHA-256 → 32 bytes → curve scalar.
 * Salt must be stored with the public key (it is not secret).
 */
export async function deriveKeypairFromPassphrase(passphrase, saltHex = null) {
  if (!passphrase || passphrase.length < 8) {
    throw new Error('Passphrase must be at least 8 characters');
  }
  const salt = saltHex ? hexToBytes(saltHex) : randomBytes(16);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  let sk = bytesToScalar(new Uint8Array(bits));
  if (sk === 0n) sk = 1n;
  return {
    method: 'passphrase',
    secretKey: scalarToHex(sk),
    publicKey: G.multiply(sk).toHex(true),
    salt: bytesToHex(salt),
    kdf: { name: 'PBKDF2-HMAC-SHA-256', iterations: PBKDF2_ITERATIONS },
    createdAt: new Date().toISOString(),
  };
}

/**
 * Method C — import an existing secret (hex) from backup / paper.
 */
export function importSecretKey(secretKeyHex) {
  const publicKey = publicKeyFromSecret(secretKeyHex);
  return {
    method: 'import',
    secretKey: String(secretKeyHex).replace(/^0x/, '').trim().toLowerCase(),
    publicKey,
    createdAt: new Date().toISOString(),
  };
}

export function publicKeyFromSecret(secretKeyHex) {
  const sk = hexToScalar(secretKeyHex);
  if (sk === 0n) throw new Error('Invalid secret key');
  return G.multiply(sk).toHex(true);
}

export function fingerprintPublicKey(publicKeyHex) {
  const h = sha256Hex(publicKeyHex);
  return h.slice(0, 4) + '…' + h.slice(-4) + ' · ' + publicKeyHex.slice(0, 8) + '…';
}

// ─── Encrypted vault storage (AES-GCM + PBKDF2) ───────────────

async function deriveAesKey(passphrase, saltBytes) {
  const base = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Seal identity (includes secretKey) into an encrypted vault blob.
 * Unlock passphrase is separate from any key-derivation passphrase.
 */
export async function encryptVault(identity, unlockPassphrase) {
  if (!unlockPassphrase || unlockPassphrase.length < 8) {
    throw new Error('Unlock passphrase must be at least 8 characters');
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveAesKey(unlockPassphrase, salt);
  const plain = new TextEncoder().encode(JSON.stringify(identity));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: 'PBKDF2-HMAC-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToHex(salt),
    iv: bytesToHex(iv),
    ciphertext: bytesToHex(new Uint8Array(cipher)),
    publicKey: identity.publicKey || null,
    sealedAt: new Date().toISOString(),
  };
}

export async function decryptVault(vault, unlockPassphrase) {
  if (!vault?.ciphertext || !vault?.salt || !vault?.iv) {
    throw new Error('Invalid vault');
  }
  const key = await deriveAesKey(unlockPassphrase, hexToBytes(vault.salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: hexToBytes(vault.iv) },
    key,
    hexToBytes(vault.ciphertext)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

export function saveVaultToBrowser(vault) {
  localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
}

export function loadVaultFromBrowser() {
  try {
    const raw = localStorage.getItem(VAULT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearVaultFromBrowser() {
  localStorage.removeItem(VAULT_KEY);
}

// ─── Convenience plaintext storage (discouraged) ──────────────

export function saveIdentity(identity) {
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
}

export function loadIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearIdentity() {
  localStorage.removeItem(IDENTITY_KEY);
}

export function clearAllLocalSecrets() {
  clearIdentity();
  clearVaultFromBrowser();
}

// ─── Export formats ───────────────────────────────────────────

export function buildPaperWallet(identity) {
  const lines = [
    '══════════════════════════════════════════',
    '  FAMILY ZKP VOTE — PAPER KEY BACKUP',
    '  KEEP OFFLINE · DO NOT PHOTOGRAPH IN CLOUD',
    '══════════════════════════════════════════',
    '',
    `Created:     ${identity.createdAt || '—'}`,
    `Method:      ${identity.method || '—'}`,
    `Public key:  ${identity.publicKey}`,
    `Fingerprint: ${fingerprintPublicKey(identity.publicKey)}`,
    '',
    '── SECRET KEY (never share) ──────────────',
    identity.secretKey,
    '',
  ];
  if (identity.salt) {
    lines.push('── PASSPHRASE SALT (needed to re-derive) ─');
    lines.push(identity.salt);
    lines.push('');
  }
  lines.push('── NOTES ─────────────────────────────────');
  lines.push('• Server never receives this secret.');
  lines.push('• Voting uses a ring signature + key image.');
  lines.push('• Lose this → you cannot cast a ballot.');
  lines.push('══════════════════════════════════════════');
  return lines.join('\n');
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function downloadJson(filename, obj) {
  downloadText(filename, JSON.stringify(obj, null, 2), 'application/json');
}

// ─── Ring vote signing ────────────────────────────────────────

export function electionKeyImage(secretKeyHex, publicKeyHex, electionId) {
  const sk = hexToScalar(secretKeyHex);
  const hp = hashToPoint(
    concatBytes(
      new TextEncoder().encode('election-key-image:'),
      new TextEncoder().encode(electionId),
      hexToBytes(publicKeyHex)
    )
  );
  return hp.multiply(sk).toHex(true);
}

export function ballotMessage({ electionId, choice, keyImage }) {
  return `vote|${electionId}|${choice}|${keyImage}`;
}

export function signVote({ electionId, choice, ringPublicKeys, secretKeyHex }) {
  const n = ringPublicKeys.length;
  if (n < 1) throw new Error('Empty ring');

  const sk = hexToScalar(secretKeyHex);
  const myPk = G.multiply(sk).toHex(true);
  const signerIndex = ringPublicKeys.indexOf(myPk);
  if (signerIndex < 0) {
    throw new Error(
      'Your key is not in the voter ring (did you register before voting opened?)'
    );
  }

  const keyImageHex = electionKeyImage(secretKeyHex, myPk, electionId);
  const message = ballotMessage({
    electionId,
    choice,
    keyImage: keyImageHex,
  });

  const P = ringPublicKeys.map((hex) => Point.fromHex(hex));
  const Hp = ringPublicKeys.map((hex) =>
    hashToPoint(
      concatBytes(
        new TextEncoder().encode('election-key-image:'),
        new TextEncoder().encode(electionId),
        hexToBytes(hex)
      )
    )
  );
  const I = Point.fromHex(keyImageHex);

  const s = new Array(n);
  const c = new Array(n);

  const alpha = bytesToScalar(randomBytes(32));
  const L_pi = G.multiply(alpha);
  const R_pi = Hp[signerIndex].multiply(alpha);
  c[(signerIndex + 1) % n] = challengeHash(message, L_pi, R_pi);

  for (let step = 1; step < n; step++) {
    const i = (signerIndex + step) % n;
    s[i] = bytesToScalar(randomBytes(32));
    const Li = G.multiply(s[i]).add(P[i].multiply(c[i]));
    const Ri = Hp[i].multiply(s[i]).add(I.multiply(c[i]));
    c[(i + 1) % n] = challengeHash(message, Li, Ri);
  }

  s[signerIndex] = modN(alpha - modN(c[signerIndex] * sk));

  return {
    keyImage: keyImageHex,
    c0: scalarToHex(c[0]),
    s: s.map(scalarToHex),
    ring: [...ringPublicKeys],
    message,
    messageHash: sha256Hex(message),
    choice,
    electionId,
  };
}

// ─── Offline context + signed ballot packages ─────────────────

export function contextHash(ctx) {
  const canonical = JSON.stringify({
    electionId: ctx.electionId,
    candidates: ctx.candidates,
    ring: ctx.ring,
  });
  return sha256Hex(canonical);
}

export function buildOfflineContext(ctx) {
  const pack = {
    type: 'zkp-family-vote-offline-context',
    version: 1,
    title: ctx.title || null,
    electionId: ctx.electionId,
    candidates: [...ctx.candidates],
    ring: [...ctx.ring],
    ringSize: ctx.ring.length,
    downloadedAt: new Date().toISOString(),
  };
  pack.contextHash = contextHash(pack);
  return pack;
}

/**
 * Offline hash-signing pipeline:
 * 1. Load offline context (public ring + candidates)
 * 2. Sign choice with secret key → ring signature
 * 3. Package signature + messageHash for later online submit
 * Secret key never enters the package.
 */
export function buildOfflineBallot({ offlineContext, choice, secretKeyHex }) {
  if (offlineContext?.type !== 'zkp-family-vote-offline-context') {
    throw new Error('Invalid offline context file');
  }
  const expected = contextHash(offlineContext);
  if (offlineContext.contextHash && offlineContext.contextHash !== expected) {
    throw new Error('Offline context was tampered with (hash mismatch)');
  }
  if (!offlineContext.candidates.includes(choice)) {
    throw new Error('Choice not in this election');
  }

  const signature = signVote({
    electionId: offlineContext.electionId,
    choice,
    ringPublicKeys: offlineContext.ring,
    secretKeyHex,
  });

  return {
    type: 'zkp-family-vote-ballot',
    version: 1,
    contextHash: expected,
    messageHash: signature.messageHash,
    message: signature.message,
    signedAt: new Date().toISOString(),
    // Only the proof — no secret key
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
}

export function parseOfflineBallot(obj) {
  if (obj?.type !== 'zkp-family-vote-ballot' || !obj.signature) {
    throw new Error('Not a valid offline ballot package');
  }
  // Integrity: message hash must match
  const mh = sha256Hex(obj.signature.message || '');
  if (obj.messageHash && obj.messageHash !== mh) {
    throw new Error('Ballot messageHash does not match signature.message');
  }
  return obj;
}

/** Human-readable explanation of storage tiers for UI */
export const STORAGE_METHODS = [
  {
    id: 'session',
    title: 'Session only',
    risk: 'Low residual risk',
    detail:
      'Key lives in page memory until you close the tab. Safest on a shared computer; you must re-import to vote later.',
  },
  {
    id: 'vault',
    title: 'Encrypted vault (recommended)',
    risk: 'Medium convenience',
    detail:
      'AES-256-GCM ciphertext in localStorage. Unlock with a passphrase. Server never sees the unlock phrase or secret.',
  },
  {
    id: 'plaintext',
    title: 'Browser plaintext',
    risk: 'Higher risk',
    detail:
      'Secret stored in localStorage unencrypted. Convenient on a personal device; clear after the election.',
  },
  {
    id: 'file',
    title: 'Encrypted or paper file',
    risk: 'You control the disk',
    detail:
      'Download a sealed vault JSON or a paper-wallet text file. Keep offline (USB, printed, password manager).',
  },
];

export const KEY_METHODS = [
  {
    id: 'random',
    title: 'Random key',
    detail:
      '32 bytes from the device CSPRNG, reduced to a secp256k1 scalar. Not recoverable if lost — back it up.',
  },
  {
    id: 'passphrase',
    title: 'Passphrase-derived',
    detail:
      'PBKDF2 (210k iterations) turns a long passphrase + public salt into the secret. Same phrase + salt → same key.',
  },
  {
    id: 'import',
    title: 'Import backup',
    detail: 'Paste a secret hex from a previous backup or paper wallet.',
  },
];
