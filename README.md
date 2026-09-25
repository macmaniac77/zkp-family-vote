# Family ZKP Vote

A **family-sized, single-server** private voting system. Ballots are written to an append-only **file chain** (`data/blockchain.jsonl`). Eligibility is proven with **linkable ring signatures** (LSAG-style on secp256k1) so the server can verify “someone on the roster voted” without learning *who*, and **key images** prevent double voting.

This replaces the original static HTML mockups (fake multi-node dashboards, hardcoded tallies, no crypto).

## What is real

| Piece | Implementation |
|--------|----------------|
| Privacy of *who* voted *what* | Ring signature over the frozen public-key roster; names never appear on vote blocks |
| Double-vote prevention | Election-scoped **key image** (nullifier) derived from the voter’s secret key |
| Proof verification | Server verifies LSAG before appending a block; auditors can re-check from chain data |
| “Blockchain” | Hash-linked JSONL file — not a public multi-node consensus network |
| Secrets | Secret keys stay in the browser; admin token stored only as a hash; invite tokens hashed |

## What this is *not*

- Not a national-scale election system
- Not multi-party compute or a decentralized node network
- Not a full zk-SNARK circuit (ring signatures give the anonymity set / ZK-style membership proof for small rings)
- The server can still observe IPs and timing unless you deploy carefully (LAN / Tor)

## Quick start

```bash
cd C:\Users\kels\Downloads\ZKP_Vote
npm install
npm start
```

Open **http://localhost:3847**

### Guided paths (recommended)

| Who | Start |
|-----|--------|
| Anyone new | `/` — step-by-step journey + role picker + **?** help |
| Voter | `/voter.html` — invite → key → **save** → register → vote |
| Organizer | `/admin.html` — access → election → invites → open/close |
| Everyone | `/results.html` — tally + chain |

1. Organizer: passphrase → create election → generate invite → copy link  
2. Each voter: open invite (voter wizard) — do **not** hand-paste public keys  
3. Organizer: when roster is ready → **Open voting**  
4. Voters: cast ballot in the same wizard  
5. Organizer: **Close** → Results  

Advanced (optional): `/keys.html`, `/offline.html`, `/register.html`, `/vote.html`.

### Automated demo

```bash
npm start
# other terminal:
npm run reset   # if you need a clean slate
npm start
npm run demo    # only works on fresh bootstrap in the same flow — see note below
```

`npm run demo` bootstraps only if the server is not yet initialized. For a clean run:

```bash
npm run reset
npm start
# then in another terminal:
npm run demo
```

## Data files

| File | Contents |
|------|----------|
| `data/blockchain.jsonl` | Append-only blocks: genesis, election events, registrations (public keys only), votes (choice + key image + proof) |
| `data/state.json` | Election config, roster labels (admin UX), hashed invites, frozen ring |

Wipe everything: `npm run reset`

## Architecture (short)

```
Browser                         Server                         Disk
───────                         ──────                         ────
secret key (local)   ──×──►     (never received)
signVote(choice, ring, sk)  ──► verify LSAG + key image
                                reject if key image seen
                                append vote block        ──► blockchain.jsonl
```

Vote block payload (conceptually):

```json
{
  "electionId": "el_…",
  "choice": "Spirited Away",
  "keyImage": "02…",
  "proof": { "scheme": "lsag-secp256k1", "c0": "…", "s": ["…"], "ring": ["…"] }
}
```

No `name`, no `voterId`, no secret key.

## Scripts

| Command | Purpose |
|---------|---------|
| `npm start` | Run server on port 3847 |
| `npm run dev` | Restart on file changes |
| `npm run reset` | Delete `data/*` |
| `npm run demo` | Scripted multi-voter exercise |

## License

Educational / household use. Not certified for official elections.
