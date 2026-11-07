import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizeBasePath} from '../src/lib/public-routes.js';
export async function publicHostHealth({env=process.env,fetchImpl=fetch}={}) {
  const host=env.HOST||'127.0.0.1',port=Number(env.PORT||5373);
  if(!['127.0.0.1','::1','localhost'].includes(host)||!Number.isInteger(port)||port<1||port>65535)throw new Error('Health checks require a local listening host/port.');
  const base=normalizeBasePath(env.PUBLIC_BASE_PATH||'/');
  const response=await fetchImpl(`http://${host==='::1'?'[::1]':host}:${port}${base}robots.txt`,{redirect:'error',signal:AbortSignal.timeout(3000)});
  if(response.status!==200||!response.headers.get('content-type')?.startsWith('text/plain')||response.headers.get('x-content-type-options')!=='nosniff')throw new Error('Public host health response failed.');
  const text=await response.text();
  if(env.PUBLIC_INDEXABLE!=='true'&&!/^Disallow: \/$/m.test(text))throw new Error('Staging indexing protection failed.');
  if(env.PUBLIC_INDEXABLE==='true'&&(!/^Allow: \/$/m.test(text)||!/^Sitemap: https?:\/\//m.test(text)))throw new Error('Approved indexable robots response failed.');
  return true;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await publicHostHealth();console.log('Public host local health passed.');}
  catch {console.error('Public host local health failed.');process.exitCode=1;}
}
