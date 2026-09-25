import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(__dirname, '..', 'data');

for (const f of ['state.json', 'blockchain.jsonl', 'state.json.tmp']) {
  const p = path.join(DATA, f);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    console.log('Removed', p);
  }
}
console.log('Reset complete. Run npm start and open the admin page to bootstrap.');
