// Test-only static host for growth-scripture-tests (Playwright). Serves the scripture source modules, the bundled KJV
// data and a synthetic article fixture on 127.0.0.1. Nothing here is part of the public site.
import {createServer} from 'node:http';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import {resolve,extname,sep,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {createPublicResponder} from '../public-response.mjs';
import {createChurchCalendarRoute} from '../public-routes/church-calendar.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const allowed=['src/features/growth/','public/scripture/','src/style.css'];
const types={'.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json'};
const fixture=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Scripture fixture</title>
<link rel="stylesheet" href="/src/style.css"><link rel="stylesheet" href="/src/features/growth/scripture/scripture.css"></head>
<body><main id="main" class="container"><h1>Fixture</h1><div id="verse" hidden></div><article class="article-body">
<h2>John 3:16 in a heading stays plain</h2>
<p id="p1">As Jesus said in John 3:16, God loved the world. See also <a href="#x">Romans 8:28</a> and Psalm 23. Mark 2 times.</p>
<p id="p2">Paul wrote 1 Cor. 13:4–7 about love; compare <code>Gen 1:1</code>. The long passage Matthew 5:3-12 is capped.</p>
</article></main>
<script type="module">
import {mountScriptureRefs} from '/src/features/growth/scripture/hover.js';
import {mountDailyVerse} from '/src/features/growth/scripture/daily.js';
const baseUrl=location.origin+'/public/scripture/kjv/';
window.originalText=document.querySelector('article').textContent;
window.disposeRefs=mountScriptureRefs(document.querySelector('article'),{baseUrl});
mountDailyVerse(document.querySelector('#verse'),{date:new URLSearchParams(location.search).get('date')||'2026-04-05',baseUrl});
window.scriptureReady=true;
</script></body></html>`;

// The calendar page renders into a synthetic shell that loads the real site stylesheet.
const dist=await mkdtemp(join(tmpdir(),'scripture-test-'));
await writeFile(join(dist,'index.html'),'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>x</title><meta name="description" content="x"><link rel="stylesheet" href="/src/style.css"></head><body><a class="skip-link" href="#main">Skip to content</a><div id="app"></div></body></html>');
const calendar=createChurchCalendarRoute({dist,basePath:'/'});
const server=createServer(async(req,res)=>{
  try {
    const path=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(path.startsWith('/church-calendar'))return void await calendar(new URL(req.url,'http://127.0.0.1'),createPublicResponder(req,res));
    if(path==='/scripture/calendar.css'){res.writeHead(200,{'Content-Type':types['.css']});return res.end(await readFile(resolve(root,'public/scripture/calendar.css')));}
    if(path==='/fixture.html'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(fixture);}
    const relative=path.slice(1);
    const file=resolve(root,relative);
    if(!allowed.some(prefix=>relative.startsWith(prefix)) || !file.startsWith(root+sep) || !types[extname(file)])throw new Error('Not served');
    const body=await readFile(file);
    res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':'no-store'});res.end(body);
  } catch {res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}
});
const port=Number(process.env.SCRIPTURE_TEST_PORT||5291);
server.listen(port,'127.0.0.1',()=>console.log(`Scripture test host on ${port}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
