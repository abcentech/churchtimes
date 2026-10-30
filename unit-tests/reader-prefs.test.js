import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {readPrefs,resolvePrefs,applyPrefs,settingsMarkup,TEXT_STEPS} from '../src/lib/reader-prefs.js';

const memory=(initial={})=>{const map=new Map(Object.entries(initial));return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k),map};};
const broken={getItem(){throw new Error('denied');},setItem(){throw new Error('denied');},removeItem(){throw new Error('denied');}};
const root=()=>({dataset:{}});

test('Saved preferences are read defensively and default to the device settings',()=>{
  assert.deepEqual(readPrefs(memory()),{theme:'system',contrast:'system',text:1});
  assert.deepEqual(readPrefs(memory({'ct-theme':'dark','ct-contrast':'more','ct-text':'4'})),{theme:'dark',contrast:'more',text:4});
  assert.deepEqual(readPrefs(memory({'ct-theme':'<script>','ct-contrast':'max','ct-text':'9'})),{theme:'system',contrast:'system',text:1});
  assert.deepEqual(readPrefs(broken),{theme:'system',contrast:'system',text:1});
  assert.equal(TEXT_STEPS.length,5);
});

test('System choices follow the device; explicit choices win',()=>{
  assert.deepEqual(resolvePrefs({theme:'system',contrast:'system',text:1},{prefersDark:true,prefersMore:true}),{theme:'dark',contrast:'more',text:null});
  assert.deepEqual(resolvePrefs({theme:'light',contrast:'normal',text:3},{prefersDark:true,prefersMore:true}),{theme:'light',contrast:null,text:'3'});
  assert.deepEqual(resolvePrefs({theme:'dark',contrast:'more',text:0}),{theme:'dark',contrast:'more',text:'0'});
});

test('Applying stores only non-default choices and still applies when storage is blocked',()=>{
  const storage=memory({'ct-text':'2'}),el=root();
  assert.equal(applyPrefs({theme:'dark',contrast:'system',text:1},{root:el,storage,media:()=>false}),true);
  assert.deepEqual(Object.fromEntries(storage.map),{'ct-theme':'dark'});
  assert.deepEqual(el.dataset,{theme:'dark'});
  const blocked=root();
  assert.equal(applyPrefs({theme:'light',contrast:'more',text:4},{root:blocked,storage:broken,media:()=>true}),false);
  assert.deepEqual(blocked.dataset,{theme:'light',contrast:'more',text:'4'});
});

test('The settings dialog uses labelled radio groups with the saved values checked',()=>{
  const html=settingsMarkup({theme:'dark',contrast:'system',text:3});
  assert.equal((html.match(/<fieldset><legend>/g)||[]).length,3);
  assert.match(html,/value="dark" checked/);
  assert.match(html,/name="contrast" value="system" checked/);
  assert.match(html,/name="text" value="3" checked/);
  assert.match(html,/aria-label="Close display settings"/);
});

// Run the real inline head script against fake browser globals: it must agree with resolvePrefs.
function runBootstrap(saved,env={}) {
  const html=readFileSync(new URL('../src/index.template.html',import.meta.url),'utf8');
  const source=html.match(/<script id="reader-prefs-bootstrap">([\s\S]*?)<\/script>/)[1];
  const element=root(),queries=[];
  // Storage is read by key (localStorage['ct-theme']); null simulates storage that throws (blocked site data).
  const storage=saved===null?new Proxy({},{get(){throw new Error('denied');}}):{...saved};
  const context={document:{documentElement:element},localStorage:storage,matchMedia:q=>{const list={query:q,matches:Boolean(q.includes('dark')?env.dark:env.more)};queries.push(list);return list;}};
  vm.runInNewContext(source,context);
  return {dataset:element.dataset,listeners:queries.filter(list=>typeof list.onchange==='function')};
}
test('The inline head bootstrap applies saved preferences before first paint',()=>{
  assert.deepEqual({...runBootstrap({}).dataset},{theme:'light'});
  assert.deepEqual({...runBootstrap({},{dark:true,more:true}).dataset},{theme:'dark',contrast:'more'});
  assert.deepEqual({...runBootstrap({'ct-theme':'light','ct-contrast':'normal','ct-text':'2'},{dark:true,more:true}).dataset},{theme:'light',text:'2'});
  assert.deepEqual({...runBootstrap({'ct-theme':'x','ct-text':'7'}).dataset},{theme:'light'});
  assert.deepEqual({...runBootstrap(null,{dark:true}).dataset},{theme:'dark'});
  const run=runBootstrap({});assert.deepEqual(run.listeners.map(list=>list.query).sort(),['(prefers-color-scheme:dark)','(prefers-contrast:more)']);
  // A device colour-scheme change re-runs the same decision without a reload.
  const env={dark:false},live=runBootstrap({},env);assert.equal(live.dataset.theme,'light');
  env.dark=true;live.listeners.find(list=>list.query.includes('dark')).onchange();assert.equal(live.dataset.theme,'dark');
});

test('No public stylesheet sets interface type below 12px',()=>{
  const files=[];
  const walk=dir=>{for(const name of readdirSync(dir)){const file=join(dir,name);if(statSync(file).isDirectory())walk(file);else if(name.endsWith('.css'))files.push(file);}};
  walk(fileURLToPath(new URL('../src',import.meta.url)));
  assert.ok(files.length>5);
  const small=[];
  for(const file of files)for(const [declaration,size] of readFileSync(file,'utf8').matchAll(/font(?:-size)?:\s*(?:[a-z0-9 ]*\s)?(\d+(?:\.\d+)?)px/g))if(Number(size)<12)small.push(`${file}: ${declaration}`);
  assert.deepEqual(small,[]);
});
