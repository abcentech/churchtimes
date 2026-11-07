// Synthetic test host for the actual production shell; no CMS endpoint is implemented.
import {createServer} from 'node:http';
import {readFile,mkdtemp,cp,rm} from 'node:fs/promises';
import {join,extname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {exportReaderPages} from './public-reader-export.mjs';
const scratch=await mkdtemp(join(tmpdir(),'reader-shell-'));
await cp('dist',scratch,{recursive:true});await exportReaderPages(scratch,{basePath:'/preview/'});
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.webp':'image/webp','.png':'image/png'};
const server=createServer(async(req,res)=>{
 try {
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  const preview=pathname.startsWith('/preview/');const root=resolve(preview?scratch:'dist');
  let path=preview?pathname.slice('/preview'.length):pathname;
  if(path==='/' || /\/newsletter\/(confirm|unsubscribe)\/?$/.test(path))path=path.replace(/\/?$/,'/index.html');
  const file=resolve(root,'.'+decodeURIComponent(path));if(!file.startsWith(root+'/'))throw Error('Invalid');
  const body=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(body);
 } catch {res.writeHead(404);res.end('Not found');}
});
server.listen(6198,'127.0.0.1');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(async()=>{await rm(scratch,{recursive:true,force:true});process.exit(0);}));
