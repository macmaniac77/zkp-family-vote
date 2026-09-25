/**
 * Election + roster state (not the vote chain).
 * Intentionally stores:
 *   - public keys (eligible ring)
 *   - display labels for admin UX only
 *   - invite tokens (hashed)
 * Never stores: vote choices linked to people, secret keys, raw invite after claim.
 */

import fs from 'fs';
import path from 'path';
import { sha256Hex, randomToken, safeEqual } from './crypto.js';

const DEFAULT_STATE = () => ({
  version: 1,
  adminTokenHash: null,
  election: null,
  // { id, label, publicKey, registeredAt } — label is admin-only roster UX
  voters: [],
  // invite: { id, label, tokenHash, used, createdAt }
  invites: [],
  // frozen ring of public keys once voting opens
  frozenRing: null,
  createdAt: null,
});

export class Store {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = DEFAULT_STATE();
    this._ensure();
    this._load();
  }

  _ensure() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.state.createdAt = new Date().toISOString();
      this._save();
    }
  }

  _load() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    this.state = { ...DEFAULT_STATE(), ...JSON.parse(raw) };
  }

  _save() {
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  isBootstrapped() {
    return Boolean(this.state.adminTokenHash);
  }

  bootstrapAdmin(adminToken) {
    if (this.state.adminTokenHash) {
      throw new Error('Admin already initialized');
    }
    this.state.adminTokenHash = sha256Hex(adminToken);
    this.state.createdAt = new Date().toISOString();
    this._save();
  }

  checkAdmin(adminToken) {
    if (!this.state.adminTokenHash) return false;
    return safeEqual(this.state.adminTokenHash, sha256Hex(adminToken || ''));
  }

  getPublicSnapshot() {
    const e = this.state.election;
    return {
      bootstrapped: this.isBootstrapped(),
      election: e
        ? {
            id: e.id,
            title: e.title,
            candidates: e.candidates,
            status: e.status, // setup | registration | open | closed
            createdAt: e.createdAt,
            openedAt: e.openedAt || null,
            closedAt: e.closedAt || null,
            voterCount: this.state.voters.filter((v) => v.publicKey).length,
            inviteCount: this.state.invites.length,
            ringFrozen: Boolean(this.state.frozenRing?.length),
            ringSize: this.state.frozenRing?.length || 0,
          }
        : null,
    };
  }

  getAdminSnapshot() {
    return {
      ...this.getPublicSnapshot(),
      voters: this.state.voters.map((v) => ({
        id: v.id,
        label: v.label,
        publicKey: v.publicKey
          ? v.publicKey.slice(0, 12) + '…' + v.publicKey.slice(-8)
          : null,
        registered: Boolean(v.publicKey),
        registeredAt: v.registeredAt || null,
      })),
      invites: this.state.invites.map((i) => ({
        id: i.id,
        label: i.label,
        used: i.used,
        createdAt: i.createdAt,
      })),
    };
  }

  createElection({ title, candidates }) {
    if (this.state.election && this.state.election.status !== 'closed') {
      throw new Error('An election is already active. Close it before creating another.');
    }
    if (!title?.trim()) throw new Error('Title required');
    if (!Array.isArray(candidates) || candidates.length < 2) {
      throw new Error('Need at least 2 candidates');
    }
    const cleaned = [...new Set(candidates.map((c) => String(c).trim()).filter(Boolean))];
    if (cleaned.length < 2) throw new Error('Need at least 2 distinct candidates');

    this.state.election = {
      id: 'el_' + randomToken(8),
      title: title.trim(),
      candidates: cleaned,
      status: 'registration',
      createdAt: new Date().toISOString(),
      openedAt: null,
      closedAt: null,
    };
    this.state.voters = [];
    this.state.invites = [];
    this.state.frozenRing = null;
    this._save();
    return this.state.election;
  }

  createInvite(label) {
    this._requireElectionStatuses(['registration']);
    const token = randomToken(16);
    const invite = {
      id: 'inv_' + randomToken(6),
      label: (label || 'Family member').trim(),
      tokenHash: sha256Hex(token),
      used: false,
      createdAt: new Date().toISOString(),
    };
    this.state.invites.push(invite);
    this._save();
    // return raw token once — never stored
    return { id: invite.id, label: invite.label, token };
  }

  peekInvite(token) {
    const hash = sha256Hex(token || '');
    const inv = this.state.invites.find((i) => safeEqual(i.tokenHash, hash));
    if (!inv) return null;
    return {
      id: inv.id,
      label: inv.label,
      used: inv.used,
      electionId: this.state.election?.id,
      electionTitle: this.state.election?.title,
      status: this.state.election?.status,
    };
  }

  registerVoter({ token, publicKey }) {
    this._requireElectionStatuses(['registration']);
    if (!publicKey || typeof publicKey !== 'string' || publicKey.length < 60) {
      throw new Error('Invalid public key');
    }
    if (this.state.voters.some((v) => v.publicKey === publicKey)) {
      throw new Error('This public key is already registered');
    }
    const hash = sha256Hex(token || '');
    const inv = this.state.invites.find((i) => safeEqual(i.tokenHash, hash));
    if (!inv) throw new Error('Invalid invite');
    if (inv.used) throw new Error('Invite already used');

    inv.used = true;
    const voter = {
      id: 'v_' + randomToken(6),
      label: inv.label,
      publicKey,
      registeredAt: new Date().toISOString(),
      inviteId: inv.id,
    };
    this.state.voters.push(voter);
    this._save();
    return {
      voterId: voter.id,
      label: voter.label,
      publicKey,
      electionId: this.state.election.id,
    };
  }

  openVoting() {
    this._requireElectionStatuses(['registration']);
    const pks = this.state.voters.map((v) => v.publicKey).filter(Boolean);
    if (pks.length < 1) throw new Error('Need at least one registered voter');
    this.state.frozenRing = [...pks];
    this.state.election.status = 'open';
    this.state.election.openedAt = new Date().toISOString();
    this._save();
    return {
      electionId: this.state.election.id,
      ring: this.state.frozenRing,
      candidates: this.state.election.candidates,
    };
  }

  closeVoting() {
    this._requireElectionStatuses(['open']);
    this.state.election.status = 'closed';
    this.state.election.closedAt = new Date().toISOString();
    this._save();
    return this.state.election;
  }

  getFrozenRing() {
    return this.state.frozenRing ? [...this.state.frozenRing] : null;
  }

  getElection() {
    return this.state.election;
  }

  _requireElectionStatuses(allowed) {
    if (!this.state.election) throw new Error('No election');
    if (!allowed.includes(this.state.election.status)) {
      throw new Error(
        `Election status is "${this.state.election.status}", expected one of: ${allowed.join(', ')}`
      );
    }
  }
}
