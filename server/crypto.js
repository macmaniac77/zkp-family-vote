/**
 * Family-scale private voting crypto
 * ----------------------------------
 * - Ed25519-style? No: secp256k1 linkable ring signatures (LSAG-style)
 * - Key image = nullifier (prevents double voting without revealing who)
 * - Ring signature proves "one registered key signed this ballot"
 *   without revealing which family member
 *
 * Ballot secrecy: chain stores choice + keyImage, never a name/id link.
 * Tally transparency: anyone can count choices on the chain.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from '@noble/hashes/utils';

const Point = secp256k1.ProjectivePoint;
const CURVE_ORDER = secp256k1.CURVE.n;
const G = Point.BASE;

export function toHex(bytes) {
  return bytesToHex(bytes);
}

export function fromHex(hex) {
  return hexToBytes(hex.replace(/^0x/, ''));
}

export function hashHex(...parts) {
  const bytes = parts.map((p) => {
    if (typeof p === 'string') {
      if (/^[0-9a-fA-F]+$/.test(p) && p.length % 2 === 0 && p.length >= 16) {
        try {
          return fromHex(p);
        } catch {
          return new TextEncoder().encode(p);
        }
      }
      return new TextEncoder().encode(p);
    }
    if (p instanceof Uint8Array) return p;
    return new TextEncoder().encode(String(p));
  });
  return toHex(sha256(concatBytes(...bytes)));
}

export function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return toHex(sha256(bytes));
}

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
  return toHex(scalarToBytes(scalar));
}

function hexToScalar(hex) {
  const b = fromHex(hex);
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return modN(x);
}

/** Deterministic hash-to-curve (try-and-increment on x-coordinate). */
export function hashToPoint(data) {
  const seed = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  for (let i = 0; i < 256; i++) {
    const candidate = sha256(concatBytes(seed, Uint8Array.of(i)));
    // Force even y by using compressed form 0x02 || x
    const compressed = new Uint8Array(33);
    compressed[0] = 0x02;
    compressed.set(candidate, 1);
    try {
      return Point.fromHex(toHex(compressed));
    } catch {
      // try odd y
      compressed[0] = 0x03;
      try {
        return Point.fromHex(toHex(compressed));
      } catch {
        // continue
      }
    }
  }
  throw new Error('hashToPoint failed');
}

export function generateKeypair() {
  const skBytes = randomBytes(32);
  let sk = bytesToScalar(skBytes);
  if (sk === 0n) sk = 1n;
  const pk = G.multiply(sk);
  return {
    secretKey: scalarToHex(sk),
    publicKey: pk.toHex(true),
  };
}

export function publicKeyFromSecret(secretKeyHex) {
  const sk = hexToScalar(secretKeyHex);
  if (sk === 0n) throw new Error('Invalid secret key');
  return G.multiply(sk).toHex(true);
}

/** Key image / nullifier: I = sk * Hp(pk). Same sk always produces same I. */
export function keyImage(secretKeyHex, publicKeyHex) {
  const sk = hexToScalar(secretKeyHex);
  const hp = hashToPoint(fromHex(publicKeyHex));
  return hp.multiply(sk).toHex(true);
}

/**
 * Election-scoped nullifier so the same key can vote in different elections.
 * I = sk * Hp("election" || electionId || pk)
 */
export function electionKeyImage(secretKeyHex, publicKeyHex, electionId) {
  const sk = hexToScalar(secretKeyHex);
  const hp = hashToPoint(
    concatBytes(
      new TextEncoder().encode('election-key-image:'),
      new TextEncoder().encode(electionId),
      fromHex(publicKeyHex)
    )
  );
  return hp.multiply(sk).toHex(true);
}

function challengeHash(message, L, R) {
  return bytesToScalar(
    sha256(
      concatBytes(
        new TextEncoder().encode(message),
        fromHex(L.toHex(true)),
        fromHex(R.toHex(true))
      )
    )
  );
}

/**
 * Sign a ballot for an election (LSAG-style linkable ring signature).
 * Proves knowledge of one secret key in the ring and binds a key image
 * so the same key cannot sign twice for the same election.
 * message binds: electionId + choice + keyImage
 */
export function signVote({ electionId, choice, ringPublicKeys, secretKeyHex }) {
  const n = ringPublicKeys.length;
  if (n < 1) throw new Error('Need at least one registered voter in the ring');

  const sk = hexToScalar(secretKeyHex);
  const myPk = G.multiply(sk).toHex(true);
  const signerIndex = ringPublicKeys.indexOf(myPk);
  if (signerIndex < 0) {
    throw new Error('Your public key is not in the frozen voter ring');
  }

  const keyImageHex = electionKeyImage(secretKeyHex, myPk, electionId);
  const message = `vote|${electionId}|${choice}|${keyImageHex}`;

  const P = ringPublicKeys.map((hex) => Point.fromHex(hex));
  const Hp = ringPublicKeys.map((hex) =>
    hashToPoint(
      concatBytes(
        new TextEncoder().encode('election-key-image:'),
        new TextEncoder().encode(electionId),
        fromHex(hex)
      )
    )
  );
  const I = Point.fromHex(keyImageHex);

  const s = new Array(n);
  const c = new Array(n);

  // random alpha for signer
  const alpha = bytesToScalar(randomBytes(32));
  const L_pi = G.multiply(alpha);
  const R_pi = Hp[signerIndex].multiply(alpha);

  // c_{π+1} = H(m, L_π, R_π)
  c[(signerIndex + 1) % n] = challengeHash(message, L_pi, R_pi);

  // walk around the ring
  for (let step = 1; step < n; step++) {
    const i = (signerIndex + step) % n;
    s[i] = bytesToScalar(randomBytes(32));
    const Li = G.multiply(s[i]).add(P[i].multiply(c[i]));
    const Ri = Hp[i].multiply(s[i]).add(I.multiply(c[i]));
    c[(i + 1) % n] = challengeHash(message, Li, Ri);
  }

  // close the ring: s_π = alpha - c_π * sk
  s[signerIndex] = modN(alpha - modN(c[signerIndex] * sk));

  return {
    keyImage: keyImageHex,
    c0: scalarToHex(c[0]),
    s: s.map(scalarToHex),
    ring: [...ringPublicKeys],
    message,
    choice,
    electionId,
  };
}

/**
 * Verify a vote ring signature and key image binding.
 */
export function verifyVote(sig) {
  const { keyImage, c0, s, ring, choice, electionId } = sig;
  if (!ring?.length || !s || s.length !== ring.length) {
    return { ok: false, reason: 'Malformed signature' };
  }

  const message = `vote|${electionId}|${choice}|${keyImage}`;
  if (sig.message && sig.message !== message) {
    return { ok: false, reason: 'Message mismatch' };
  }

  let I;
  try {
    I = Point.fromHex(keyImage);
  } catch {
    return { ok: false, reason: 'Invalid key image' };
  }

  const n = ring.length;
  const P = [];
  const Hp = [];
  try {
    for (const hex of ring) {
      P.push(Point.fromHex(hex));
      Hp.push(
        hashToPoint(
          concatBytes(
            new TextEncoder().encode('election-key-image:'),
            new TextEncoder().encode(electionId),
            fromHex(hex)
          )
        )
      );
    }
  } catch {
    return { ok: false, reason: 'Invalid ring public key' };
  }

  const c = new Array(n);
  c[0] = hexToScalar(c0);

  try {
    for (let i = 0; i < n; i++) {
      const si = hexToScalar(s[i]);
      const Li = G.multiply(si).add(P[i].multiply(c[i]));
      const Ri = Hp[i].multiply(si).add(I.multiply(c[i]));
      const next = challengeHash(message, Li, Ri);
      if (i < n - 1) {
        c[i + 1] = next;
      } else {
        // final challenge must equal c0
        if (next !== c[0]) {
          return { ok: false, reason: 'Ring signature verification failed' };
        }
      }
    }
  } catch (e) {
    return { ok: false, reason: e.message || 'Verification error' };
  }

  return { ok: true, keyImage, choice, electionId, message };
}

/** Constant-time-ish string compare for tokens */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ba.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < ba.length; i++) out |= ba[i] ^ bb[i];
  return out === 0;
}

export function randomToken(bytes = 24) {
  return toHex(randomBytes(bytes));
}
