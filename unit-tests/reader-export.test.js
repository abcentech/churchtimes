import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {exportReaderPages} from '../tools/public-reader-export.mjs';
test('Exported preference routes have an explicit safe asset base before the bootstrap',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'reader-export-'));
 try {
  await writeFile(join(dir,'index.html'),'<html><head><script>/* bootstrap STUB */</script></head></html>');
  await exportReaderPages(dir,{basePath:'/preview/'});
  for(const action of ['confirm','unsubscribe']){
   const shell=await readFile(join(dir,'newsletter',action,'index.html'),'utf8');assert.ok(shell.indexOf('<base href="/preview/">')<shell.indexOf('<script>'));
  }
  await assert.rejects(exportReaderPages(dir,{basePath:'//external.example/'}));
 } finally {await rm(dir,{recursive:true,force:true});}
});
