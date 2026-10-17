// Dependency-free public copy of proposed C7.1 redirectPaths from CMS PR #55
// (a90183c), with the reviewed NFC correction. Fixture provenance is recorded in
// tools/fixtures/public-redirect-paths.json. Real CMS parity awaits the CMS fix.
export const PATH_MAX=300;
const CONTROL=/[\u0000-\u001f\u007f-\u009f]/;
const EXTENSION=/\.[A-Za-z0-9]{1,10}$/;
const HOST=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const fail=reason=>({ok:false,reason});
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,c=>'%'+c.charCodeAt(0).toString(16).toUpperCase());
export function normalizePath(input) {
 if(typeof input!=='string')return fail('must be text');
 const raw=input.trim();
 if(!raw)return fail('is empty');
 if(raw.length>2048)return fail('is too long');
 if(CONTROL.test(raw))return fail('contains control characters');
 if(/\s/u.test(raw))return fail('contains whitespace');
 if(raw.includes('\\'))return fail('contains a backslash');
 if(!raw.startsWith('/'))return fail('must be a path starting with /');
 if(raw.startsWith('//'))return fail('must not start with //');
 if(/[?#]/.test(raw))return fail('must not contain a query string or fragment');
 if(raw.includes('*'))return fail('must not contain wildcards');
 const trailing=raw.endsWith('/'),segments=raw.slice(1,trailing?-1:undefined).split('/');
 if(raw==='/')return {ok:true,path:'/'};
 const encoded=[];
 for(const segment of segments) {
  if(!segment)return fail('contains an empty segment');
  let text;
  try {text=decodeURIComponent(segment).normalize('NFC');}catch{return fail('contains invalid percent encoding or UTF-8');}
  if(CONTROL.test(text))return fail('contains an encoded control character');
  if(text==='.'||text==='..')return fail('contains a dot segment');
  try {encoded.push(encode(text));}catch{return fail('contains an invalid character');}
 }
 const last=encoded.at(-1),path='/'+encoded.join('/')+(trailing||!EXTENSION.test(last)?'/':'');
 return path.length>PATH_MAX?fail('is longer than 300 characters'):{ok:true,path};
}
export function normalizeRequestPath(target) {
 if(typeof target!=='string')return null;
 const result=normalizePath(target.split(/[?#]/,1)[0]);return result.ok?result.path:null;
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
