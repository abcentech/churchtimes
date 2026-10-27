import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validPushAppId,mountPublicPush} from '../src/lib/public-push.js';
import {writePublicPushWorker,PUSH_WORKER_FILENAME} from '../tools/public-push-worker.mjs';
const appId='11111111-1111-4111-8111-111111111111'; // STUB public configuration, never a real OneSignal application.
test('push rejects missing or injected IDs without touching DOM or provider',()=>{
  for(const input of [undefined,'','not-an-id','<script>',appId+'\n'])assert.equal(validPushAppId(input),'');
  assert.equal(validPushAppId(appId),appId);
  assert.doesNotThrow(()=>mountPublicPush({root:{},appId:'',window:{},document:{}})());
});
test('push worker is absent when unset, fixed-origin when configured, and removed after withdrawal',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'ct-push-'));
  try {
    assert.equal(await writePublicPushWorker({directory,appId:''}),false);
    await assert.rejects(readFile(join(directory,PUSH_WORKER_FILENAME)),{code:'ENOENT'});
    await assert.rejects(writePublicPushWorker({directory,appId:'injected'}),/UUID/);
    assert.equal(await writePublicPushWorker({directory,appId}),true);
    assert.equal(await readFile(join(directory,PUSH_WORKER_FILENAME),'utf8'),"// Generated only for an owner-approved configured build.\nimportScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');\n");
    assert.equal(await writePublicPushWorker({directory,appId:''}),false);
    await assert.rejects(readFile(join(directory,PUSH_WORKER_FILENAME)),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});
