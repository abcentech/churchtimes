import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
// Inert public shells: loading one never submits a newsletter token.
export async function exportReaderPages(directory,{basePath=process.env.PUBLIC_BASE_PATH||'/'}={}) {
  if(!/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(basePath))throw new Error('PUBLIC_BASE_PATH must be a root-relative directory path');
  const html=await readFile(join(directory,'index.html'),'utf8');
  if(/<base\b/i.test(html))throw new Error('Newsletter export expects the unmodified public shell');
  const shell=html.replace(/<head>/i,`<head>\n    <base href="${basePath}">`);
  for(const action of ['confirm','unsubscribe']) {
    const folder=join(directory,'newsletter',action);
    await mkdir(folder,{recursive:true});await writeFile(join(folder,'index.html'),shell);
  }
  await writeFile(join(directory,'newsletter','.churchtimes-reader-generated'),'Generated public newsletter preference shells.\n');
}
