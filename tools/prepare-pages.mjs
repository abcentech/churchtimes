import {exportReaderPages} from './public-reader-export.mjs';
import { mkdir, readdir, rename, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const site = join(dist, 'site');
await mkdir(site, { recursive: true });
for (const file of await readdir(dist)) {
  if (file !== 'index.html' && file !== 'site') await rename(join(dist, file), join(site, file));
}
const entry = join(dist, 'index.html');
const html = await readFile(entry, 'utf8');
await writeFile(entry, html.replace(/(src|href)="\.\//g, '$1="./site/'));
await exportReaderPages(dist);
console.log('Prepared a static Pages root with compiled assets under site/.');
