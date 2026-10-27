import {execFileSync} from 'node:child_process';
import {appendFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const exported=path=>path==='index.html'||path==='.nojekyll'||path==='OneSignalSDKWorker.js'||path.startsWith('site/')||path.startsWith('newsletter/');
export function publicBuildMode({eventName,baseRef='',refName='',headRef='',changedFiles=[]}) {
  const integration=eventName==='pull_request'?baseRef==='feat/newsroom-mvp':refName==='feat/newsroom-mvp';
  if(!integration)return 'strict'; // Main/release validation retains the committed-export check.
  const rebuild=eventName==='pull_request' && /^agent\/rebuild-site(?:[-/]|$)/.test(headRef);
  if(rebuild) {
    if(!changedFiles.some(exported))throw new Error('A dedicated rebuild PR must contain a generated export.');
    if(changedFiles.some(path=>!exported(path)&&!path.startsWith('docs/')))throw new Error('Dedicated rebuild PRs may change only generated exports and docs; merge feature source first.');
    return 'strict';
  }
  if(eventName==='pull_request' && changedFiles.some(exported))throw new Error('Feature PRs must not change site/, newsletter/, index.html or .nojekyll. Edit src/index.template.html and rebuild once in a dedicated agent/rebuild-site PR.');
  // The integration push after an approved rebuild must also prove the export.
  if(eventName==='push' && changedFiles.some(exported)) {
    if(changedFiles.some(path=>!exported(path)&&!path.startsWith('docs/')))throw new Error('Integration pushes must keep feature source and generated rebuilds separate.');
    return 'strict';
  }
  return 'source';
}
export function changedPublicFiles({baseSha,headSha,cwd,pullRequest=false}) {
  for(const sha of [baseSha,headSha])if(!/^[a-f0-9]{40}$/i.test(sha||'')||/^0+$/.test(sha))throw new Error('Public build policy requires explicit nonzero event base and head commit SHAs.');
  for(const sha of [baseSha,headSha])execFileSync('git',['rev-parse','--verify',sha+'^{commit}'],{cwd,stdio:'pipe'});
  return execFileSync('git',['diff','--name-only','-z',...(pullRequest?[baseSha+'...'+headSha]:[baseSha,headSha])],{cwd,encoding:'utf8'}).split('\0').filter(Boolean);
}
export async function checkPublicBuildPolicy(env=process.env,cwd=process.cwd()) {
  const context={eventName:env.PUBLIC_CI_EVENT,baseRef:env.PUBLIC_CI_BASE_REF,refName:env.PUBLIC_CI_REF_NAME,headRef:env.PUBLIC_CI_HEAD_REF};
  const integration=context.eventName==='pull_request'?context.baseRef==='feat/newsroom-mvp':context.refName==='feat/newsroom-mvp';
  if(integration)context.changedFiles=changedPublicFiles({baseSha:env.PUBLIC_CI_BASE_SHA,headSha:env.PUBLIC_CI_HEAD_SHA,cwd,pullRequest:context.eventName==='pull_request'});
  const mode=publicBuildMode(context);
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,`mode=${mode}\n`);
  const message=mode==='source'?'Compiled-source validation selected. The committed Pages export is pending a dedicated rebuild and is NOT checked for freshness.':'Strict committed Pages export validation selected.';
  console.log(message);
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,message+'\n');
  return mode;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await checkPublicBuildPolicy();
