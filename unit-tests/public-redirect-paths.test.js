import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePath,normalizeRequestPath,normalizeTarget,parseAllowedHosts} from '../tools/public-redirect-paths.mjs';
const vectors=JSON.parse(readFileSync(new URL('../tools/fixtures/public-redirect-paths.json',import.meta.url),'utf8'));
test('synthetic C7 canonical vectors cover UTF-8, apostrophes, uppercase bytes and NFC equivalence',()=>{
 for(const {input,path} of vectors.valid){assert.deepEqual(normalizePath(input),{ok:true,path},String(input));assert.deepEqual(normalizePath(path),{ok:true,path});}
 for(const input of vectors.invalid)assert.equal(normalizePath(input).ok,false,String(input));
 assert.equal(normalizeRequestPath("/caf%c3%a9-it's?broken=%"),'/caf%C3%A9-it%27s/');
 assert.equal(normalizeRequestPath('/old?x=%#top'),'/old/');
});
test('C7 target and allowlist normalization matches the proposed bare-host contract',()=>{
 const hosts=parseAllowedHosts({REDIRECT_ALLOWED_HOSTS:' WWW.Example.test,example.test,www.example.test '});assert.deepEqual(hosts,['www.example.test','example.test']);
 assert.deepEqual(normalizeTarget('https://WWW.Example.test/Cafe%CC%81',hosts),{ok:true,to:'https://www.example.test/Caf%C3%A9/',external:true});
 for(const value of ['https://example.test:8443/a/','https://user@example.test/a/','https://example.test/a/?x=1','https://example.test/a/#x','http://example.test/a/'])assert.equal(normalizeTarget(value,hosts).ok,false);
 for(const value of ['*.example.test','example.test:8443','https://example.test'])assert.throws(()=>parseAllowedHosts({REDIRECT_ALLOWED_HOSTS:value}));
});
