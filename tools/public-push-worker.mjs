import {writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {validPushAppId} from '../src/lib/public-push.js';
export const PUSH_WORKER_FILENAME='OneSignalSDKWorker.js';
export const PUSH_WORKER_SOURCE="// Generated only for an owner-approved configured build.\nimportScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');\n";
// Build source only; never commit the generated provider worker in a feature PR.
export async function writePublicPushWorker({directory,appId=process.env.VITE_PUBLIC_ONESIGNAL_APP_ID}={}) {
  const file=join(directory,PUSH_WORKER_FILENAME);
  if(!appId){await rm(file,{force:true});return false;}
  if(!validPushAppId(appId))throw Error('The public OneSignal app ID must be a UUID.');
  await mkdir(directory,{recursive:true});
  await writeFile(file,PUSH_WORKER_SOURCE);
  return true;
}

async function worker(directory) {
  try {return await readFile(join(directory,PUSH_WORKER_FILENAME),'utf8');}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
}
export async function exportPublicPushWorker({sourceDirectory,targetDirectory}) {
  const source=await worker(sourceDirectory),existing=await worker(targetDirectory);
  if(source!==null&&source!==PUSH_WORKER_SOURCE)throw Error('Generated push worker has unexpected content.');
  if(existing!==null&&existing!==PUSH_WORKER_SOURCE)throw Error('Refusing to overwrite an unrecognised root push worker.');
  if(source===null)await rm(join(targetDirectory,PUSH_WORKER_FILENAME),{force:true});
  else await writeFile(join(targetDirectory,PUSH_WORKER_FILENAME),source);
}
export async function checkPublicPushWorkerExport({sourceDirectory,targetDirectory}) {
  const source=await worker(sourceDirectory),target=await worker(targetDirectory);
  if(source!==target||(source!==null&&source!==PUSH_WORKER_SOURCE))throw Error('Stale or unexpected root push worker export.');
}
