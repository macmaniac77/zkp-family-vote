/**
 * Wizard help: ? buttons open plain-language + diagram modals.
 * Usage: data-help="invite" on a button.help-q  OR  Help.open('invite')
 */

const HELP = {
  roles: {
    title: 'Who are you in this election?',
    body: `
      <p><strong>Organizer (admin)</strong> — one person in the household who starts the election, creates invite links, and opens/closes voting.</p>
      <p><strong>Voter</strong> — anyone who received an invite link. You create a secret key on your device, register, then cast one ballot.</p>
      <p>Most families: one organizer, several voters. You can be both (use Admin first, then open your own invite as a voter).</p>
    `,
    diagram: `
ORGANIZER                         VOTERS
   │                                 │
   ├─ create election                │
   ├─ make invite links ────────────►│ each person gets their own link
   ├─ wait for registrations         ├─ save secret key
   ├─ open voting                    ├─ register public key
   ├─ close & see tally              └─ vote (once)
`,
  },

  journey: {
    title: 'The whole process (big picture)',
    body: `
      <p>Nothing magical: <strong>admin invites people → each person keeps a secret key → only the public half is registered → votes are anonymous on a file chain</strong>.</p>
      <ol>
        <li>Organizer sets a passphrase and creates an election.</li>
        <li>Organizer generates one invite link per person and sends it.</li>
        <li>Each voter creates a key, <em>saves the secret</em>, registers the public key.</li>
        <li>Organizer opens voting.</li>
        <li>Voters cast a ballot (secret never uploaded).</li>
        <li>Anyone can see the tally on the Results page.</li>
      </ol>
    `,
    diagram: `
[Admin]  election + invites
            │
            ▼
[You]  secret key (keep!)  +  public key (send to server)
            │
            ▼
[Server]  ring of public keys  →  open voting
            │
            ▼
[You]  signed ballot (proof, not your name)
            │
            ▼
[File]  data/blockchain.jsonl  →  public tally
`,
  },

  invite: {
    title: 'What is an invite?',
    body: `
      <p>An invite is a <strong>one-time secret link</strong> the organizer creates for you (e.g. “for Alex”).</p>
      <p>It is <em>not</em> your name and not your vote. It only proves the organizer said “this person may register one public key.”</p>
      <p><strong>You cannot invent an invite.</strong> If lookup fails, ask the organizer for a new link.</p>
      <p>After you successfully register, that invite is burned (single-use).</p>
    `,
    diagram: `
Admin clicks “Generate invite”
        │
        ▼
  https://…/voter.html?invite=LONG_HEX
        │
        │  (send via text / Signal / note)
        ▼
  You open link → wizard knows who invited you
        │
        ▼
  After register: invite used ✓  (cannot reuse)
`,
  },

  secret_key: {
    title: 'What is the secret key?',
    body: `
      <p>Your <strong>secret key</strong> is a long random code that lives on <em>your</em> device. It is your voting identity.</p>
      <ul>
        <li><strong>Never</strong> send it to the organizer or paste it into a chat.</li>
        <li>The server is designed to <strong>never receive</strong> it.</li>
        <li>If you lose it, you cannot vote with that registration.</li>
        <li>Anyone who steals it could vote as you — treat it like a password.</li>
      </ul>
      <p>The wizard will not let you continue until you confirm you saved it (download, copy, or password manager).</p>
    `,
    diagram: `
  SECRET KEY (sk)          PUBLIC KEY (pk)
  ───────────────          ───────────────
  stays on your phone      derived from secret
  used to SIGN a ballot    sent only at register
  never on the chain       appears in voter ring

  Like: house key          Like: street address
  (don’t mail it)          (ok to list publicly)
`,
  },

  public_key: {
    title: 'What is the public key?',
    body: `
      <p>The <strong>public key</strong> is the half of your identity that is safe to send to the server.</p>
      <p>You do <strong>not</strong> need to copy/paste it yourself in the voter wizard — we send it automatically when you register.</p>
      <p>Later, when you vote, a cryptographic proof shows “someone who knows the matching secret signed this” without writing your name next to the choice.</p>
    `,
    diagram: `
Your device                         Server / chain
───────────                         ─────────────
sk  ──never──►
pk  ─────────►  stored in roster
                frozen into “ring”
vote: sign with sk
      send proof only  ─────────►  ballot block
                                   (choice + proof, no name)
`,
  },

  save_backup: {
    title: 'Why must I save before continuing?',
    body: `
      <p>Browsers forget things. Tabs close. Phones update. If your secret only lived in temporary memory, you could lose your vote.</p>
      <p><strong>Good options:</strong></p>
      <ul>
        <li>Download the backup file to a USB or private folder</li>
        <li>Copy into a password manager secure note</li>
        <li>Write it on paper kept offline</li>
      </ul>
      <p><strong>Bad options:</strong> screenshot to iCloud/Google Photos group chat, email to yourself in plain text, Discord.</p>
    `,
    diagram: `
  [Generate key]
        │
        ▼
  [Download / copy backup]  ← wizard blocks here until you confirm
        │
        ▼
  [Register public key]
        │
        ▼
  [Later: vote with same secret]
`,
  },

  register: {
    title: 'What does “register” do?',
    body: `
      <p>Registration tells the server: <strong>“this public key is allowed to vote once.”</strong></p>
      <p>It uses up your invite. It does <strong>not</strong> cast a vote and does <strong>not</strong> upload your secret.</p>
      <p>After everyone who should vote has registered, the organizer opens voting. New registrations then stop.</p>
    `,
    diagram: `
Before open:     invite + public key  →  “you’re on the list”
After open:      list freezes into a ring of public keys
Voting:          only those keys can produce a valid ballot proof
`,
  },

  vote: {
    title: 'How does voting stay private?',
    body: `
      <p>Your ballot on the chain looks like: <em>choice + cryptographic proof + key image</em>.</p>
      <p>The proof shows you are <strong>one of the registered keys</strong> without saying which person. The key image stops you from voting twice.</p>
      <p>Names from invites are only for the organizer’s checklist — they are <strong>not</strong> written next to ballots on the chain.</p>
    `,
    diagram: `
Chain vote block
────────────────
choice: "Pizza"
keyImage: 02ab…     ← prevents double vote (not your name)
proof: ring signature over all public keys
        “one of us signed” — not “Alex signed”
`,
  },

  admin_pass: {
    title: 'Admin passphrase',
    body: `
      <p>This is the organizer’s master password. You choose it once at setup.</p>
      <p>It is stored only as a hash. If you forget it, you must reset the data folder and start over (which clears the election).</p>
      <p>Save it in a password manager. Use “Remember in this browser” only on a trusted family computer.</p>
    `,
    diagram: `
You type passphrase  →  server stores SHA-256 hash only
Later requests send passphrase in a header  →  server checks hash
Raw passphrase is never written to the vote chain
`,
  },

  open_close: {
    title: 'Open and close voting',
    body: `
      <p><strong>Open</strong> freezes who may vote (the public-key ring). No more registrations after that.</p>
      <p><strong>Close</strong> stops new ballots and writes the final tally onto the chain file.</p>
      <p>Wait until everyone who needs to has registered before you open.</p>
    `,
    diagram: `
registration ──Open──► voting open ──Close──► closed + tally on chain
   ↑                      ↑
 invites & keys        ballots accepted
`,
  },

  chain: {
    title: 'What is the “chain” file?',
    body: `
      <p>Every important event is appended to <code>data/blockchain.jsonl</code> on the server: election created, public keys enrolled, votes, open/close.</p>
      <p>Blocks are hash-linked (each block includes the previous hash), so tampering with history is detectable.</p>
      <p>This is a <strong>single-server file log</strong>, not Bitcoin. Good for a household; honest about its limits.</p>
    `,
    diagram: `
genesis → election → register… → open → vote → vote → close+tally
   │         │            │         │      │      │       │
 hash0 ←── hash1 ←────── hash2 … each points to previous
`,
  },

  offline: {
    title: 'Offline signing (optional advanced)',
    body: `
      <p>Most people can ignore this and vote online in the wizard.</p>
      <p>Advanced: download a public “context pack,” sign offline, submit only the signature file later — secret still never uploaded.</p>
    `,
    diagram: `
Online: get context pack (public)
Offline: sk + choice → signature package
Online: submit package (no sk inside)
`,
  },
};

function ensureModal() {
  let root = document.getElementById('help-modal-root');
  if (root) return root;
  root = document.createElement('div');
  root.id = 'help-modal-root';
  root.innerHTML = `
    <div class="help-backdrop" data-close="1"></div>
    <div class="help-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title">
      <div class="help-dialog-head">
        <h2 id="help-title">Help</h2>
        <button type="button" class="help-close" data-close="1" aria-label="Close">×</button>
      </div>
      <div class="help-dialog-body" id="help-body"></div>
      <div class="help-dialog-foot">
        <button type="button" class="btn" data-close="1">Got it</button>
      </div>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('open')) close();
  });
  return root;
}

export function open(id) {
  const entry = HELP[id];
  const root = ensureModal();
  const title = root.querySelector('#help-title');
  const body = root.querySelector('#help-body');
  if (!entry) {
    title.textContent = 'Help';
    body.innerHTML = '<p class="muted">No help topic for “' + id + '”.</p>';
  } else {
    title.textContent = entry.title;
    body.innerHTML =
      entry.body +
      (entry.diagram
        ? '<div class="help-diagram-label">Picture</div><pre class="diagram help-diagram">' +
          entry.diagram.trim() +
          '</pre>'
        : '');
  }
  root.classList.add('open');
  document.body.classList.add('help-open');
}

export function close() {
  const root = document.getElementById('help-modal-root');
  if (root) root.classList.remove('open');
  document.body.classList.remove('help-open');
}

/** Wire all [data-help] buttons on the page */
export function bindHelpButtons(root = document) {
  root.querySelectorAll('[data-help]').forEach((el) => {
    if (el.dataset.helpBound) return;
    el.dataset.helpBound = '1';
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      open(el.getAttribute('data-help'));
    });
  });
}

export function helpButton(id, label = '?') {
  return (
    '<button type="button" class="help-q" data-help="' +
    id +
    '" title="What is this?" aria-label="Help">' +
    label +
    '</button>'
  );
}

export { HELP };
