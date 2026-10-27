// Framing protection: the newsletter confirm and unsubscribe pages hold POST buttons. Synthetic local host, no CMS.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPublicServer} from '../tools/serve-public.mjs';
import {publicHostConfig} from '../tools/public-host.mjs';
test('every public host response forbids framing; the Caddy reference does the same and leaves HSTS commented',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'public-frame-'));await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 await mkdir(join(dist,'assets'));await writeFile(join(dist,'assets','synthetic.js'),'export {}');
 const server=createPublicServer({dist,siteUrl:'https://public.example.test',adsTxtLine:'example.test, synthetic-publisher, DIRECT'});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const path of ['/','/latest/','/newsletter/confirm?token=synthetic','/newsletter/unsubscribe/','/ads.txt','/robots.txt','/sitemap.xml','/assets/synthetic.js','/missing-story/','/%ZZ','/about']) {
  const response=await fetch(origin+path,{redirect:'manual'});
  assert.equal(response.headers.get('x-frame-options'),'DENY',path);
  assert.equal(response.headers.get('content-security-policy'),"frame-ancestors 'none'",path);
  await response.arrayBuffer();
 }
 const caddy=await readFile(new URL('../deploy/public-host/Caddyfile',import.meta.url),'utf8');
 assert.match(caddy,/^\s+X-Frame-Options "DENY"$/m);assert.match(caddy,/^\s+Content-Security-Policy "frame-ancestors 'none'"$/m);
 assert.match(caddy,/^\s*#\s*Strict-Transport-Security /m);assert.doesNotMatch(caddy,/^\s*Strict-Transport-Security /m);
 assert.doesNotMatch(caddy,/PUBLIC_HOSTNAME:/,'hostname must fail closed: no placeholder default');
});
test('host kit defaults: root article path (D1), empty PORT falls back, port 0 only under test',()=>{
 const base={PUBLIC_SITE_URL:'https://public.example.test'};
 assert.equal(publicHostConfig(base).options.articlePathTemplate,'/{slug}/');
 assert.equal(publicHostConfig({...base,PUBLIC_ARTICLE_PATH_TEMPLATE:'/reports/{slug}/'}).options.articlePathTemplate,'/reports/{slug}/');
 assert.equal(publicHostConfig({...base,PORT:''}).port,5373);
 assert.throws(()=>publicHostConfig({...base,PORT:'0'}));
 assert.equal(publicHostConfig({...base,PORT:'0',NODE_ENV:'test'}).port,0);
});
