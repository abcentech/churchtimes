import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
async function compare(source, target) {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const a = join(source, entry.name), b = join(target, entry.name);
    if (entry.isDirectory()) await compare(a, b);
    else if (!(await readFile(a)).equals(await readFile(b))) throw new Error(`Stale Pages export: ${b}. Run npm run export:pages before committing.`);
  }
}
if (!(await readFile(join(root, 'dist/index.html'))).equals(await readFile(join(root, 'index.html')))) throw new Error('Stale index.html export. Run npm run export:pages before committing.');
await compare(join(root, 'dist/site'), join(root, 'site'));
await compare(join(root,'dist/newsletter'),join(root,'newsletter'));
console.log('The committed Pages export matches the current build.');
