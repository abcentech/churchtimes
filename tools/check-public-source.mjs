import {readFile,realpath,stat} from 'node:fs/promises';
import {dirname,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

// Validate the actual Vite output, independently from the committed Pages export.
export async function checkPublicSource(dist=resolve('dist')) {
  const root=await realpath(dist);
  async function localAsset(reference,from=root,baseHref) {
    let base=new URL('https://build.invalid/'+(from===root?'':from.slice(root.length+1).split(sep).join('/')+'/'));
    if(baseHref!==undefined)base=new URL(baseHref,base);
    if(base.origin!=='https://build.invalid'||base.search||base.hash||!base.pathname.endsWith('/'))throw new Error('Compiled public page has an unsafe asset base.');
    const url=new URL(reference,base);
    if(url.origin!=='https://build.invalid'||url.search||url.hash)throw new Error('Compiled public asset must be a local build file.');
    // A configured public base (/preview/) is a host mount, not a disk directory.
    let pathname=url.pathname;
    if(baseHref!==undefined) {
      if(!pathname.startsWith(base.pathname))throw new Error('Compiled public asset escaped its configured base.');
      pathname='/'+pathname.slice(base.pathname.length);
    }
    const path=decodeURIComponent(pathname);
    if(path.includes('\\')||path.includes('\0')||path.includes('/src/'))throw new Error('Source entry or unsafe path in compiled public output.');
    let file;
    try {file=await realpath(resolve(root,'.'+path));}catch{throw new Error('Referenced compiled public asset is missing.');}
    if(!file.startsWith(root+sep))throw new Error('Compiled public asset escaped the build directory.');
    const info=await stat(file);if(!info.isFile()||!info.size)throw new Error('Compiled public asset is empty or not a file.');
    return file;
  }
  async function page(file) {
    const html=await readFile(file,'utf8'),baseHref=html.match(/<base\b[^>]*\bhref="([^"]+)"/i)?.[1];
    const scripts=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)].map(match=>match[1]);
    const styles=[...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)].map(match=>match[1]);
    if(!scripts.length||!styles.length)throw new Error('Compiled public JS/CSS entries are missing.');
    for(const entry of scripts)await localAsset(entry,dirname(file),baseHref);
    for(const entry of styles) {
      const cssFile=await localAsset(entry,dirname(file),baseHref),css=await readFile(cssFile,'utf8');
      for(const match of css.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)) {
        if(match[1].startsWith('data:'))continue;
        await localAsset(match[1],dirname(cssFile));
      }
    }
  }
  await page(resolve(root,'index.html'));
  for(const route of ['confirm','unsubscribe']) {
    const file=resolve(root,'newsletter',route,'index.html');
    try {await stat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    await page(file);
  }
  console.log('Actual compiled public JS/CSS and stylesheet assets exist locally, including generated reader route pages when present. Committed Pages export freshness is a separate check.');
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await checkPublicSource(process.argv[2]);
