import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {publicBuildMode,changedPublicFiles} from '../tools/public-build-policy.mjs';
import {checkPublicSource} from '../tools/check-public-source.mjs';
const feature={eventName:'pull_request',baseRef:'feat/newsroom-mvp',headRef:'agent/synthetic-feature'};
test('feature PRs cannot publish generated bundles or change the generated HTML entry',()=>{
 for(const path of ['site/assets/synthetic.js','site/.churchtimes-generated','index.html','.nojekyll','newsletter/confirm/index.html','newsletter/unsubscribe/index.html','OneSignalSDKWorker.js'])assert.throws(()=>publicBuildMode({...feature,changedFiles:[path]}),/Feature PRs must not change/);
 assert.equal(publicBuildMode({...feature,changedFiles:['src/index.template.html','src/main.js','public/synthetic.svg']}),'source');
});
test('dedicated rebuilds require generated exports, exclude source changes and retain strict checks',()=>{
 const rebuild={...feature,headRef:'agent/rebuild-site-wave2'};
 assert.equal(publicBuildMode({...rebuild,changedFiles:['site/assets/synthetic.js','index.html','newsletter/confirm/index.html','OneSignalSDKWorker.js','docs/synthetic-build.md']}),'strict');
 assert.throws(()=>publicBuildMode({...rebuild,changedFiles:['docs/synthetic-build.md']}),/must contain/);
 for(const path of ['src/main.js','tools/export-pages.mjs','.github/workflows/ci.yml'])assert.throws(()=>publicBuildMode({...rebuild,changedFiles:['index.html',path]}),/only generated exports and docs/);
});
test('integration source pushes declare pending exports; rebuild pushes and main stay strict',()=>{
 assert.equal(publicBuildMode({eventName:'push',refName:'feat/newsroom-mvp',changedFiles:['src/main.js']}),'source');
 assert.equal(publicBuildMode({eventName:'push',refName:'feat/newsroom-mvp',changedFiles:['index.html','site/assets/synthetic.js']}),'strict');
 assert.throws(()=>publicBuildMode({eventName:'push',refName:'feat/newsroom-mvp',changedFiles:['index.html','src/main.js']}),/keep feature source and generated rebuilds separate/);
 assert.equal(publicBuildMode({eventName:'push',refName:'main'}),'strict');
 assert.equal(publicBuildMode({...feature,baseRef:'main'}),'strict');
});
async function temporary(t,prefix) {
 const root=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(root,{recursive:true,force:true}));return root;
}
test('event commit SHAs select actual Git changes, including generated files, without guessing a base',async t=>{
 const root=await temporary(t,'public-policy-git-');
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
 git('init');await writeFile(join(root,'README.md'),'Synthetic fixture\n');git('add','.');git('-c','user.name=Synthetic test','-c','user.email=synthetic@example.test','commit','-m','Synthetic base');const baseSha=git('rev-parse','HEAD');
 await mkdir(join(root,'site'));await writeFile(join(root,'site','synthetic bundle.js'),'Synthetic export\n');git('add','.');git('-c','user.name=Synthetic test','-c','user.email=synthetic@example.test','commit','-m','Synthetic generated change');const headSha=git('rev-parse','HEAD');
 assert.deepEqual(changedPublicFiles({cwd:root,baseSha,headSha}),['site/synthetic bundle.js']);
 assert.throws(()=>publicBuildMode({...feature,changedFiles:changedPublicFiles({cwd:root,baseSha,headSha})}),/Feature PRs must not change/);
 git('checkout','-b','synthetic-integration',baseSha);await writeFile(join(root,'index.html'),'Synthetic newer integration export');git('add','.');git('-c','user.name=Synthetic test','-c','user.email=synthetic@example.test','commit','-m','Synthetic newer base');const newerBase=git('rev-parse','HEAD');
 assert.deepEqual(changedPublicFiles({cwd:root,baseSha:newerBase,headSha,pullRequest:true}),['site/synthetic bundle.js']);
 for(const invalid of ['', '0'.repeat(40),'HEAD~1','--help'])assert.throws(()=>changedPublicFiles({cwd:root,baseSha:invalid,headSha}),/explicit nonzero/);
});
async function build(t) {
 const root=await temporary(t,'public-built-fixture-');await mkdir(join(root,'site','assets'),{recursive:true});
 await writeFile(join(root,'index.html'),'<script type="module" src="./site/assets/main.js"></script><link rel="stylesheet" href="./site/assets/main.css">');
 await writeFile(join(root,'site/assets/main.js'),'console.log("synthetic compiled fixture")');
 await writeFile(join(root,'site/assets/main.css'),'@font-face{src:url(./synthetic.woff2)}');
 await writeFile(join(root,'site/assets/synthetic.woff2'),'synthetic font bytes');return root;
}
test('actual compiled files and CSS dependencies are required, independently of committed exports',async t=>{
 const root=await build(t);await checkPublicSource(root);
 await rm(join(root,'site/assets/synthetic.woff2'));await assert.rejects(checkPublicSource(root),/asset is missing/);
});
test('missing, empty, remote and source entries cannot pass compiled source validation',async t=>{
 const root=await build(t),entry=join(root,'site/assets/main.js');
 await writeFile(entry,'');await assert.rejects(checkPublicSource(root),/empty or not a file/);
 await rm(entry);await assert.rejects(checkPublicSource(root),/asset is missing/);
 for(const src of ['/src/main.js','https://external.example.test/main.js']) {
  await writeFile(join(root,'index.html'),`<script src="${src}"></script><link rel="stylesheet" href="./site/assets/main.css">`);
  await assert.rejects(checkPublicSource(root),/Source entry|local build file/);
 }
});
test('asset symlinks cannot escape the build directory',async t=>{
 const root=await build(t),outside=await temporary(t,'public-outside-fixture-');
 await writeFile(join(outside,'synthetic.js'),'synthetic outside asset');await rm(join(root,'site/assets/main.js'));
 try {await symlink(join(outside,'synthetic.js'),join(root,'site/assets/main.js'));}
 catch(error) {if(process.platform==='win32'&&error.code==='EPERM'){t.skip('Windows symlink creation requires developer mode or privileges');return;}throw error;}
 await assert.rejects(checkPublicSource(root),/escaped the build directory/);
});
test('generated newsletter pages validate real assets with root and mounted base paths',async t=>{
 const root=await build(t);
 await writeFile(join(root,'site/assets/reader-route.js'),'synthetic route chunk');
 for(const base of ['/','/preview/']) {
  for(const route of ['confirm','unsubscribe']) {
   const directory=join(root,'newsletter',route);await mkdir(directory,{recursive:true});
   await writeFile(join(directory,'index.html'),`<base href="${base}"><script src="./site/assets/reader-route.js"></script><link rel="stylesheet" href="./site/assets/main.css">`);
  }
  await checkPublicSource(root);
 }
 await rm(join(root,'site/assets/reader-route.js'));await assert.rejects(checkPublicSource(root),/asset is missing/);
});
