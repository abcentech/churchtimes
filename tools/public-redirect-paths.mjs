// Dependency-free public copy of proposed C7.1 redirectPaths from CMS PR #55
// (a90183c), with the reviewed NFC correction. Fixture provenance is recorded in
// tools/fixtures/public-redirect-paths.json. Real CMS parity awaits the CMS fix.
export const PATH_MAX=300;
const LS_PS=String.fromCharCode(0x2028,0x2029);
const CONTROL=new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${LS_PS}]`);
const DECODED_CONTROL=new RegExp(`[\\u0080-\\u009f${LS_PS}]`);
const EXTENSION=/\.[A-Za-z0-9]{1,10}$/;
const SCHEME=/^[A-Za-z][A-Za-z0-9+.-]*:/;
const JUNK_SCHEME=/^(?:tel|mailto|javascript|data|https?):/i;
const HOST=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const HEX=/^[0-9A-Fa-f]{2}$/;
const FORBIDDEN_ENCODED=new Set([0x2f,0x5c,0x25,0x23]);
const isUnreserved=b=>(b>=0x30&&b<=0x39)||(b>=0x41&&b<=0x5a)||(b>=0x61&&b<=0x7a)||b===0x2d||b===0x2e||b===0x5f||b===0x7e;
const encodeByte=b=>isUnreserved(b)?String.fromCharCode(b):'%'+b.toString(16).toUpperCase().padStart(2,'0');
const fail=reason=>({ok:false,reason});
// Port of apps/cms/src/lib/redirectPaths.ts normalizePath (C7.1). Keep in step; vectors: apps/cms/tests/fixtures/redirect-normalisation.json.
export function normalizePath(input) {
 if(typeof input!=='string')return fail('must be text');
 const raw=input.trim();
 if(raw==='')return fail('is empty');
 if(raw.length>2048)return fail('is too long');
 if(CONTROL.test(raw))return fail('contains control characters');
 if(/\s/u.test(raw))return fail('contains whitespace');
 if(raw.includes('\\'))return fail('contains a backslash');
 if(raw[0]!=='/')return fail(SCHEME.test(raw)||raw.startsWith('//')?'must be a path, not a URL':'must start with "/"');
 if(raw.startsWith('//'))return fail('must not start with "//"');
 if(raw.includes('?')||raw.includes('#'))return fail('must not contain a query string or fragment');
 if(raw.includes('*'))return fail('must not contain "*"');
 const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
 const byteSegments=[[]];const chars=Array.from(raw);
 for(let i=0;i<chars.length;i++) {
  const ch=chars[i];
  if(ch==='/'){byteSegments.push([]);continue;}
  const current=byteSegments[byteSegments.length-1];
  if(ch==='%') {
   const hex=(chars[i+1]??'')+(chars[i+2]??'');
   if(!HEX.test(hex))return fail('contains a "%" that is not followed by two hex digits');
   const byte=Number.parseInt(hex,16);
   if(byte<0x20||byte===0x7f)return fail('contains an encoded control character');
   if(FORBIDDEN_ENCODED.has(byte))return fail('contains an encoded slash, backslash, percent or hash');
   current.push(byte);i+=2;continue;
  }
  const code=ch.codePointAt(0)??0;
  if(code>=0xd800&&code<=0xdfff)return fail('contains an invalid character');
  current.push(...encoder.encode(ch));
 }
 const segments=[];
 for(let s=0;s<byteSegments.length;s++) {
  let text;
  try{text=decoder.decode(Uint8Array.from(byteSegments[s])).normalize('NFC');}catch{return fail('contains bytes that are not valid UTF-8');}
  if(DECODED_CONTROL.test(text))return fail('contains an encoded control character');
  if(text!==''&&(JUNK_SCHEME.test(text)||(s===1&&SCHEME.test(text))))return fail('has a segment that starts like a URL scheme');
  let encoded='';for(const byte of encoder.encode(text))encoded+=encodeByte(byte);
  segments.push(encoded);
 }
 const trailing=segments[segments.length-1]==='';
 const inner=segments.slice(1,trailing?-1:undefined);
 if(inner.length===0)return {ok:true,path:'/'};
 for(const seg of inner){if(seg==='')return fail('contains an empty segment');if(seg==='.'||seg==='..')return fail('contains a dot segment');}
 const last=inner[inner.length-1];
 const path='/'+inner.join('/')+(trailing||!EXTENSION.test(last)?'/':'');
 return path.length>PATH_MAX?fail('is longer than 300 characters'):{ok:true,path};
}
export function normalizeRequestPath(target) {
 if(typeof target!=='string')return null;
 const cut=target.search(/[?#]/);
 const result=normalizePath(cut===-1?target:target.slice(0,cut));return result.ok?result.path:null;
}
export function parseAllowedHosts(env={}) {
 const hosts=(env.REDIRECT_ALLOWED_HOSTS || '').split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
 if(hosts.some(host=>host.length>253||!HOST.test(host)))throw new Error('Redirect host allowlist must contain bare host names without schemes, ports or paths');
 return [...new Set(hosts)];
}
export function normalizeTarget(input,allowedHosts=[]) {
 if(typeof input!=='string')return fail('must be text');
 const raw=input.trim();
 if(raw.startsWith('/')){const result=normalizePath(raw);return result.ok?{ok:true,to:result.path,external:false}:result;}
 if(!raw || raw.length>2048 || CONTROL.test(raw) || /\s/u.test(raw) || raw.includes('\\'))return fail('invalid absolute target');
 const match=/^https:\/\/([^/?#]*)(.*)$/i.exec(raw);
 if(!match)return fail('must be a path or HTTPS URL');
 const host=match[1].toLowerCase();
 if(!HOST.test(host)||!allowedHosts.map(h=>h.toLowerCase()).includes(host))return fail('host is not allowed');
 const result=normalizePath(match[2] || '/');
 return result.ok?{ok:true,to:'https://'+host+result.path,external:true}:result;
}
