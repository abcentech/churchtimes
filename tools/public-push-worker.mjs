import {writeFile,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {validPushAppId} from '../src/lib/public-push.js';
export const PUSH_WORKER_FILENAME='OneSignalSDKWorker.js';
// Build source only; never commit the generated provider worker in a feature PR.
export async function writePublicPushWorker({directory,appId=process.env.VITE_PUBLIC_ONESIGNAL_APP_ID}={}) {
  const file=join(directory,PUSH_WORKER_FILENAME);
  if(!appId){await rm(file,{force:true});return false;}
  if(!validPushAppId(appId))throw Error('The public OneSignal app ID must be a UUID.');
  await mkdir(directory,{recursive:true});
  await writeFile(file,"// Generated only for an owner-approved configured build.\nimportScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');\n");
  return true;
}
