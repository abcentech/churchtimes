import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
// These are inert public shells. Tokens are handled in memory by the reader UI;
// loading a shell never submits or confirms a subscription.
export async function exportReaderPages(directory) {
  const html=await readFile(join(directory,'index.html'),'utf8');
  for(const action of ['confirm','unsubscribe']) {
    const folder=join(directory,'newsletter',action);
    await mkdir(folder,{recursive:true});await writeFile(join(folder,'index.html'),html);
  }
}
