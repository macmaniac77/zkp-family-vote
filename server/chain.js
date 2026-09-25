/**
 * Append-only file blockchain for ballots and election events.
 * Each block: { index, timestamp, prevHash, type, payload, hash }
 * Hash links blocks; votes never include voter names or secrets.
 */

import fs from 'fs';
import path from 'path';
import { sha256Hex, hashHex } from './crypto.js';

export class VoteChain {
  constructor(filePath) {
    this.filePath = filePath;
    this.blocks = [];
    this._ensureFile();
    this._load();
  }

  _ensureFile() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, '', 'utf8');
    }
  }

  _load() {
    const raw = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!raw) {
      this.blocks = [];
      this._appendGenesis();
      return;
    }
    this.blocks = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    // Truncated file (e.g. reset while server still running) — start clean
    if (this.blocks[0]?.type !== 'genesis' || this.blocks[0]?.index !== 0) {
      const bak = this.filePath + '.corrupt.' + Date.now() + '.bak';
      fs.copyFileSync(this.filePath, bak);
      fs.writeFileSync(this.filePath, '', 'utf8');
      this.blocks = [];
      this._appendGenesis();
      console.warn(
        `[chain] Invalid/missing genesis — archived corrupt file to ${bak} and re-initialized`
      );
      return;
    }
    this._verifyIntegrity();
  }

  _canonical(block) {
    return JSON.stringify({
      index: block.index,
      timestamp: block.timestamp,
      prevHash: block.prevHash,
      type: block.type,
      payload: block.payload,
    });
  }

  _hashBlock(block) {
    return sha256Hex(this._canonical(block));
  }

  _appendGenesis() {
    const genesis = {
      index: 0,
      timestamp: new Date().toISOString(),
      prevHash: '0'.repeat(64),
      type: 'genesis',
      payload: {
        note: 'ZKP Family Vote chain — ballots are anonymous; key images prevent double votes',
      },
    };
    genesis.hash = this._hashBlock(genesis);
    this.blocks = [genesis];
    fs.writeFileSync(this.filePath, JSON.stringify(genesis) + '\n', 'utf8');
  }

  _verifyIntegrity() {
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const expected = this._hashBlock(b);
      if (b.hash !== expected) {
        throw new Error(`Chain integrity failure at block ${i}: hash mismatch`);
      }
      if (i === 0) {
        if (b.prevHash !== '0'.repeat(64)) {
          throw new Error('Genesis prevHash invalid');
        }
      } else if (b.prevHash !== this.blocks[i - 1].hash) {
        throw new Error(`Chain broken at block ${i}: prevHash mismatch`);
      }
      if (b.index !== i) {
        throw new Error(`Block index mismatch at ${i}`);
      }
    }
  }

  tip() {
    return this.blocks[this.blocks.length - 1];
  }

  append(type, payload) {
    const prev = this.tip();
    const block = {
      index: prev.index + 1,
      timestamp: new Date().toISOString(),
      prevHash: prev.hash,
      type,
      payload,
    };
    block.hash = this._hashBlock(block);
    // Re-verify link before write
    if (block.prevHash !== prev.hash) {
      throw new Error('Race: chain tip moved');
    }
    fs.appendFileSync(this.filePath, JSON.stringify(block) + '\n', 'utf8');
    this.blocks.push(block);
    return block;
  }

  all() {
    return this.blocks.map((b) => ({ ...b }));
  }

  votesForElection(electionId) {
    return this.blocks.filter(
      (b) => b.type === 'vote' && b.payload?.electionId === electionId
    );
  }

  keyImagesForElection(electionId) {
    const set = new Set();
    for (const b of this.votesForElection(electionId)) {
      if (b.payload?.keyImage) set.add(b.payload.keyImage);
    }
    return set;
  }

  tally(electionId, candidates) {
    const counts = Object.fromEntries(candidates.map((c) => [c, 0]));
    let total = 0;
    let invalid = 0;
    for (const b of this.votesForElection(electionId)) {
      const choice = b.payload?.choice;
      if (choice in counts) {
        counts[choice] += 1;
        total += 1;
      } else {
        invalid += 1;
      }
    }
    return { counts, total, invalid, chainLength: this.blocks.length };
  }

  /** Full audit: re-hash every block and return report */
  audit() {
    const issues = [];
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const expected = this._hashBlock(b);
      if (b.hash !== expected) issues.push({ index: i, issue: 'hash mismatch' });
      if (i > 0 && b.prevHash !== this.blocks[i - 1].hash) {
        issues.push({ index: i, issue: 'broken link' });
      }
    }
    return {
      ok: issues.length === 0,
      blocks: this.blocks.length,
      tip: this.tip().hash,
      issues,
      file: this.filePath,
    };
  }
}

export function payloadFingerprint(payload) {
  return hashHex(JSON.stringify(payload));
}
