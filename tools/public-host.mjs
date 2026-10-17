// Draft runtime entry point. This starts only the public Node process, never a service.
import {resolve,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {stat,realpath} from 'node:fs/promises';
import {createPublicServer} from './serve-public.mjs';
import {checkPublicSource} from './check-public-source.mjs';
import {publicOrigin} from '../src/lib/public-url.js';

export function publicHostConfig(env=process.env) {
  const host=env.HOST||'127.0.0.1',port=Number(env.PORT??5373);
  if(!['127.0.0.1','::1','localhost'].includes(host))throw new Error('Public host must bind to loopback behind its TLS proxy.');
  if(!Number.isInteger(port)||port<0||port>65535)throw new Error('Invalid public host port.');
  const siteUrl=publicOrigin(env.PUBLIC_SITE_URL);
  if(!siteUrl||new URL(env.PUBLIC_SITE_URL).pathname!=='/'||new URL(env.PUBLIC_SITE_URL).search||new URL(env.PUBLIC_SITE_URL).hash)throw new Error('PUBLIC_SITE_URL must be an explicit safe origin.');
  if(env.PUBLIC_CMS_URL&&!publicOrigin(env.PUBLIC_CMS_URL))throw new Error('PUBLIC_CMS_URL must be HTTPS or loopback HTTP without credentials.');
  if(env.PUBLIC_REDIRECTS_FILE&&!isAbsolute(env.PUBLIC_REDIRECTS_FILE))throw new Error('PUBLIC_REDIRECTS_FILE must be an absolute private filesystem path.');
  const dist=resolve(env.PUBLIC_DIST||'dist');
  if(env.PUBLIC_REDIRECTS_FILE&&(resolve(env.PUBLIC_REDIRECTS_FILE)===dist||resolve(env.PUBLIC_REDIRECTS_FILE).startsWith(dist+sep)))throw new Error('Private redirects must be outside the public build.');
  const shutdownMs=Number(env.PUBLIC_HOST_SHUTDOWN_MS??10000);
  if(!Number.isInteger(shutdownMs)||shutdownMs<1000||shutdownMs>60000)throw new Error('Public host shutdown deadline must be between 1000 and 60000 ms.');
  return {host,port,shutdownMs,options:{
    dist,siteUrl,cmsUrl:env.PUBLIC_CMS_URL||undefined,
    basePath:env.PUBLIC_BASE_PATH||'/',indexable:env.PUBLIC_INDEXABLE==='true',
    articlePathTemplate:env.PUBLIC_ARTICLE_PATH_TEMPLATE||'/reports/{slug}/',
    adsTxtLine:env.PUBLIC_ADS_TXT_LINE||'',searchVerification:env.PUBLIC_SEARCH_CONSOLE_VERIFICATION||'',
    redirectsFile:env.PUBLIC_REDIRECTS_FILE||undefined,redirectsUrl:env.PUBLIC_REDIRECTS_URL||undefined,
    redirectPatterns:env.PUBLIC_REDIRECT_PATTERNS||undefined,
    redirectAllowedHosts:env.PUBLIC_REDIRECT_ALLOWED_HOSTS??env.REDIRECT_ALLOWED_HOSTS??'',
  }};
}
export async function startPublicHost({env=process.env,signals=process,log=record=>console.log(JSON.stringify(record))}={}) {
  const config=publicHostConfig(env);
  // Pin this process to its immutable build even if an operator selects another
  // release symlink before the approved restart.
  config.options.dist=await realpath(config.options.dist);
  await checkPublicSource(config.options.dist);
  if(config.options.redirectsFile) {
    const privatePath=await realpath(config.options.redirectsFile);
    if(privatePath===config.options.dist||privatePath.startsWith(config.options.dist+sep))throw new Error('Private redirects must be outside the public build.');
    const info=await stat(config.options.redirectsFile);
    if(!info.isFile())throw new Error('The private redirects path must be a regular file.');
  }
  const server=createPublicServer(config.options);
  if((config.options.redirectsFile||config.options.redirectsUrl)&&typeof server.publicReloadRedirects!=='function')throw new Error('Redirect runtime requires the reviewed public reload hook.');
  await server.publicReady;
  if((config.options.redirectsFile||config.options.redirectsUrl)&&server.publicRedirectDiagnostics?.().loaded!==true) {
    server.close();
    throw new Error('Configured redirects require a validated initial generation.');
  }
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(config.port,config.host,done);});
  let closing;
  const reload=()=>{
    if(closing)return;
    if(!config.options.redirectsFile&&!config.options.redirectsUrl){log({event:'public_redirect_refresh_unconfigured'});return;}
    // A failed generation preserves the old map and increments the existing warning counter.
    Promise.resolve(server.publicReloadRedirects()).then(()=>log({event:'public_redirect_refresh_finished'})).catch(()=>log({event:'public_redirect_refresh_failed'}));
  };
  const stop=()=>{
    if(closing)return closing;
    signals.off('SIGHUP',reload);
    closing=new Promise(done=>{
      const deadline=setTimeout(()=>{server.closeAllConnections();log({event:'public_host_drain_expired'});done(false);},config.shutdownMs);
      server.close(()=>{clearTimeout(deadline);log({event:'public_host_stopped'});done(true);});
      server.closeIdleConnections();
    });
    return closing;
  };
  const signalStop=()=>{void stop().then(clean=>{if(!clean)process.exitCode=1;});};
  signals.on('SIGTERM',signalStop);signals.on('SIGINT',signalStop);signals.on('SIGHUP',reload);
  server.once('close',()=>{signals.off('SIGTERM',signalStop);signals.off('SIGINT',signalStop);signals.off('SIGHUP',reload);});
  log({event:'public_host_listening',port:server.address().port});
  return {server,stop,reload};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {await startPublicHost();}
  catch {console.error('Public host could not start; check the local build and reviewed runtime configuration.');process.exitCode=1;}
}
