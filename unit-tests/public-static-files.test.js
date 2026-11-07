import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicServer} from '../tools/serve-public.mjs';

for(const prepared of [false,true])for(const basePath of ['/','/journal/']){
 test(`/site assets work with ${prepared?'prepared':'plain'} dist at ${basePath}, with traversal blocked`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'public-static-'));const dist=join(root,'dist');
  const files=prepared?join(dist,'site'):dist;
  await mkdir(join(files,'news-media'),{recursive:true});await mkdir(join(files,'assets'),{recursive:true});
  await writeFile(join(dist,'index.html'),'<html><head></head><body><div id="app"></div></body></html>');
  await writeFile(join(files,'news-media','legacy.jpg'),'synthetic-photo');
  await writeFile(join(files,'assets','bundle.js'),'synthetic-script');
  await writeFile(join(root,'private.txt'),'must-not-leak');
  await writeFile(join(dist,'not-a-site-asset.txt'),'must-not-leak');
  const server=createPublicServer({dist,basePath});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin='http://127.0.0.1:'+server.address().port;
  try{
   const photo=await fetch(origin+basePath+'site/news-media/legacy.jpg');assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/jpeg');assert.equal(await photo.text(),'synthetic-photo');
   const head=await fetch(origin+basePath+'site/news-media/legacy.jpg',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
   const script=await fetch(origin+basePath+'site/assets/bundle.js');assert.equal(script.status,200);assert.equal(script.headers.get('cache-control'),'public, max-age=31536000, immutable');
   for(const path of ['site/%2e%2e%2f%2e%2e%2fprivate.txt','site/%2e%2e%2fprivate.txt','site/%2e%2e%5cprivate.txt','site/%00private.txt']){
    const response=await fetch(origin+basePath+path);assert.ok([400,404].includes(response.status),path);assert.notEqual(await response.text(),'must-not-leak');
   }
   assert.equal((await fetch(origin+basePath+'site/missing.jpg')).status,404);
  }finally{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
 });
}
