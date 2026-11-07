// Optional public-host redirect delivery. C7 endpoint tests use a labelled stub;
// no endpoint, pattern destination or legacy-ID adapter is enabled by default.
import {readFile, stat} from 'node:fs/promises';
import {readFileSync,statSync} from 'node:fs';
import {normalizePath,normalizeRequestPath,normalizeTarget,parseAllowedHosts} from './public-redirect-paths.mjs';
import {publicOrigin} from '../src/lib/public-url.js';
import {articlePathTemplate as validateArticlePathTemplate, normalizeBasePath, reportSlug} from '../src/lib/public-routes.js';
import {publicPageRoute} from '../src/lib/public-page-routes.js';

export const MAX_REDIRECT_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECT_RULES = 20000;
const CONTROL = /[\u0000-\u0020\u007f-\u009f\u2028\u2029]/;
const DECODED_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const emptyMap = () => new Map();

/** Call on req.url BEFORE new URL normalises dot segments and before any CMS IO. */
export function isJunkPath(value) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || CONTROL.test(value) || value.includes('\\')) return true;
  const path = value.split('?')[0];
  if (path.length > 2048 || /%(?:2f|5c|25)/i.test(path)) return true;
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { return true; }
  return DECODED_CONTROL.test(decoded) || decoded.includes('\\') || decoded.includes('//') || /(?:^|\/)(?:\.{1,2})(?:\/|$)/.test(decoded)
    || /(?:^|\/)(?:tel|mailto|javascript|data|https?):/i.test(decoded) || decoded.includes('#');
}

function allowedHostSet(value = []) {
  const values = Array.isArray(value) ? value : String(value).split(',').map(v => v.trim()).filter(Boolean);
  return new Set(values.map(host => {
    if (typeof host !== 'string' || !host || /[\s/@?#\\]/.test(host)) throw new Error('Invalid redirect host allowlist');
    const url = new URL('https://' + host);
    if (url.host !== host.toLowerCase() || url.pathname !== '/' || url.username || url.password) throw new Error('Invalid redirect host allowlist');
    return url.host;
  }));
}

/** Returns only trusted configuration, never an unchecked request-derived URL. */
export function safeRedirectTarget(value, {allowedHosts = []} = {}) {
  if (typeof value !== 'string' || !value || value.length > 2048 || CONTROL.test(value) || value.includes('\\') || value.includes('#')) throw new Error('Invalid redirect destination');
  const hosts = allowedHosts instanceof Set ? allowedHosts : allowedHostSet(allowedHosts);
  if (value.startsWith('/')) {
    if (isJunkPath(value)) throw new Error('Invalid redirect destination');
    const url = new URL(value, 'https://public.invalid');
    return url.pathname + url.search;
  }
  // Test the raw path before URL parsing can normalise it.
  if (!/^https:\/\//.test(value) || /%(?:2f|5c|25)/i.test(value)) throw new Error('Invalid redirect destination');
  const url = new URL(value);
  const remainder = value.match(/^https:\/\/[^/?#]+(.*)$/)?.[1] || '/';
  const rawPath = remainder.startsWith('?') ? '/' + remainder : remainder;
  if (url.username || url.password || !hosts.has(url.host) || isJunkPath(rawPath)) throw new Error('Invalid redirect destination');
  return url.href;
}

function contractHosts(value=[]) {return new Set(parseAllowedHosts({REDIRECT_ALLOWED_HOSTS:Array.isArray(value)?value.join(','):String(value)}));}
function targetPath(to, siteUrl) {
  if (to.startsWith('/')) return normalizeRequestPath(to);
  if (siteUrl && new URL(to).origin === new URL(siteUrl).origin) return normalizeRequestPath(new URL(to).pathname);
  return null;
}

function canonicalDestination(to, {siteUrl, basePath = '/', articlePathTemplate} = {}) {
  if(!to.startsWith('/') && !siteUrl)throw new Error('PUBLIC_SITE_URL is required for absolute redirect destinations');
  const path = to.startsWith('/')?to.split('?')[0]:siteUrl&&new URL(to).origin===new URL(siteUrl).origin?new URL(to).pathname:null;
  if (path && !path.endsWith('/') && (reportSlug(path, basePath, articlePathTemplate) || publicPageRoute(path, basePath))) throw new Error('Redirect destination would need a canonical-path hop');
}

/** Full map validation is atomic: one bad row rejects the entire generation. */
export function compileRedirectMap(data, {allowedHosts = [], siteUrl, basePath = '/', articlePathTemplate} = {}) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.rules) || data.rules.length > MAX_REDIRECT_RULES
    || data.count !== data.rules.length || typeof data.version !== 'string' || !/^sha256:[a-zA-Z0-9_-]{1,128}$/.test(data.version)
    || typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt))) throw new Error('Invalid redirect map');
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_REDIRECT_BYTES) throw new Error('Redirect map exceeds size cap');
  const hosts = contractHosts(allowedHosts);
  const rules = new Map();
  for (const row of data.rules) {
    if (!row || typeof row.from !== 'string' || row.from.length > 2048 || row.from.includes('?')
      || ![301, 302, 410].includes(row.status) || !['manual', 'rank-math', 'legacy-url'].includes(row.source)) throw new Error('Invalid redirect rule');
    const source=normalizePath(row.from);if(!source.ok || rules.has(source.path))throw new Error('Invalid or duplicate canonical redirect source');
    const target=row.status===410?null:normalizeTarget(row.to,[...hosts]);
    if(target && !target.ok)throw new Error('Invalid canonical redirect target');
    const to=target?.to ? safeRedirectTarget(target.to,{allowedHosts:hosts}) : null;
    if (to) canonicalDestination(to, {siteUrl, basePath, articlePathTemplate});
    // A 410 intentionally has no Location. If the export includes a target, it must still be safe.
    if (row.status === 410 && row.to != null && row.to !== '') safeRedirectTarget(row.to, {allowedHosts: hosts});
    rules.set(source.path, {status: row.status, to});
  }
  for (const row of rules.values()) if (row.to && rules.has(targetPath(row.to, siteUrl))) throw new Error('Redirect loops and chains are forbidden');
  return rules;
}

function patternMatch(url) {
  const path = url.pathname;
  const named = path.match(/^\/(category|tag|author)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (named && named[2].length <= 160) return {kind: named[1], slug: named[2]};
  const page = path.match(/^\/page\/([1-9]\d{0,5})\/?$/);
  if (page) return {kind: 'page', page: page[1]};
  if (path === '/feed/' || path === '/feed') return {kind: 'feed'};
  const amp = path.match(/^\/(?:reports\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\/amp\/?$/)
    || path.match(/^\/amp\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (amp && amp[1].length <= 160) return {kind: 'amp', slug: amp[1]};
  const queryAmp = path.match(/^\/(?:reports\/)?([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (queryAmp && queryAmp[1].length <= 160 && url.searchParams.has('amp') && ['', '1'].includes(url.searchParams.get('amp'))) return {kind: 'amp', slug: queryAmp[1]};
  const id = url.searchParams.get('p');
  if (path === '/' && url.searchParams.getAll('p').length === 1 && /^[1-9]\d{0,14}$/.test(id || '')) return {kind: 'legacyId', id};
  return null;
}

function compilePatterns(input, hosts, routeOptions) {
  let patterns = input || {};
  if (typeof patterns === 'string') { try { patterns = JSON.parse(patterns); } catch { throw new Error('Invalid PUBLIC_REDIRECT_PATTERNS'); } }
  if (!patterns || Array.isArray(patterns) || typeof patterns !== 'object') throw new Error('Invalid PUBLIC_REDIRECT_PATTERNS');
  const placeholders = {category: 'slug', tag: 'slug', author: 'slug', page: 'page', feed: null, amp: 'slug', legacyId: 'slug'};
  const result = new Map();
  for (const [kind, template] of Object.entries(patterns)) {
    if (!Object.hasOwn(placeholders, kind) || typeof template !== 'string') throw new Error('Invalid redirect pattern');
    const placeholder = placeholders[kind];
    const matches = template.match(/\{[^}]*\}/g) || [];
    if (matches.some(value => value !== `{${placeholder}}`) || matches.length > 1 || /[{}]/.test(template.replace(`{${placeholder}}`, ''))) throw new Error('Invalid redirect pattern');
    const sample = safeRedirectTarget(template.replace(`{${placeholder}}`, kind === 'page' ? '2' : 'synthetic-article'), {allowedHosts: hosts});
    canonicalDestination(sample, routeOptions);
    result.set(kind, template);
  }
  return result;
}

async function responseJSON(response) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_REDIRECT_BYTES || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('Invalid redirect response');
  if (!response.body) throw new Error('Empty redirect response');
  const reader = response.body.getReader();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > MAX_REDIRECT_BYTES) throw new Error('Redirect response exceeds size cap');
      chunks.push(Buffer.from(value));
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Await handler({method, url, rawUrl}, respond). Respond has the public host's
 * (status, contentType, body, headers) signature. true means the request is done.
 */
export function createPublicRedirects({
 file=process.env.PUBLIC_REDIRECTS_FILE,endpoint=process.env.PUBLIC_REDIRECTS_URL,
 allowedHosts=process.env.PUBLIC_REDIRECT_ALLOWED_HOSTS ?? process.env.REDIRECT_ALLOWED_HOSTS ?? '',
 patterns=process.env.PUBLIC_REDIRECT_PATTERNS,siteUrl=process.env.PUBLIC_SITE_URL,
 basePath='/',articlePathTemplate,fetchImpl=fetch,resolveLegacyId,now=Date.now,cacheMs=300000,timeoutMs=5000,
 warn=record=>console.warn(JSON.stringify(record)),autoRefresh=true,
}={}) {
 const hosts=contractHosts(allowedHosts);
 if(process.env.PUBLIC_REDIRECT_ALLOWED_HOSTS!==undefined && process.env.REDIRECT_ALLOWED_HOSTS!==undefined) {
  const a=[...contractHosts(process.env.PUBLIC_REDIRECT_ALLOWED_HOSTS)].sort(),b=[...contractHosts(process.env.REDIRECT_ALLOWED_HOSTS)].sort();
  if(JSON.stringify(a)!==JSON.stringify(b))throw new Error('PUBLIC_REDIRECT_ALLOWED_HOSTS and REDIRECT_ALLOWED_HOSTS must match');
 }
 basePath=normalizeBasePath(basePath);articlePathTemplate=validateArticlePathTemplate(articlePathTemplate);
 const routeOptions={siteUrl,basePath,articlePathTemplate};
 const templates=compilePatterns(patterns,hosts,routeOptions);
 if(endpoint && (!publicOrigin(endpoint)||new URL(endpoint).hash||new URL(endpoint).search||new URL(endpoint).pathname!=='/api/public/redirects'))throw new Error('PUBLIC_REDIRECTS_URL must name a safe /api/public/redirects endpoint');
 if(siteUrl&&!publicOrigin(siteUrl))throw new Error('Invalid redirect site origin');
 const ttl=Math.max(1000,Math.min(300000,Number(cacheMs)||300000));
 let map=emptyMap(),expires=0,etag='',pending,again=false,warningCount=0,loaded=false,timer,closed=false;
 const configuredPattern=url=>{const match=patternMatch(url);return match&&templates.has(match.kind)?match:null;};
 const validatePatterns=candidate=>{
  for(const rule of candidate.values()) {
   const path=rule.to&&targetPath(rule.to,siteUrl);
   if(path&&configuredPattern(new URL(rule.to,siteUrl||'https://public.invalid')))throw new Error('Exact-to-pattern redirect chain');
  }
  return candidate;
 };
 function assertAbsoluteConfiguration(data) {
  if(data?.rules?.some?.(row=>typeof row?.to==='string' && /^https?:/i.test(row.to))) {
   if(!hosts.size)throw new RedirectStartupError('Absolute redirect targets require REDIRECT_ALLOWED_HOSTS (or PUBLIC_REDIRECT_ALLOWED_HOSTS)');
   if(!siteUrl)throw new RedirectStartupError('Absolute redirect targets require PUBLIC_SITE_URL');
  }
 }
 // Local configuration mistakes must be visible before the host starts serving.
 if(file) {
  try {if(statSync(file).size<=MAX_REDIRECT_BYTES)assertAbsoluteConfiguration(JSON.parse(readFileSync(file,'utf8')));}
  catch(error){if(error instanceof RedirectStartupError)throw error;}
 }
 function refresh({initial=false,force=false}={}) {
  // A reload that joins an in-flight refresh (SIGHUP right after an atomic file swap) must not be lost: run once more.
  if(pending){if(force)again=true;return pending;}
  if(!file&&!endpoint){loaded=true;return Promise.resolve(map);}
  pending=(async()=>{
   try {
    let data,nextETag='';
    if(file) {
     if((await stat(file)).size>MAX_REDIRECT_BYTES)throw new Error('Redirect file exceeds size cap');
     const bytes=await readFile(file);if(bytes.length>MAX_REDIRECT_BYTES)throw new Error('Redirect file exceeds size cap');
     data=JSON.parse(bytes.toString('utf8'));
    } else {
     const response=await fetchImpl(endpoint,{credentials:'omit',redirect:'error',headers:etag?{'If-None-Match':etag}:{},signal:AbortSignal.timeout(Math.max(1,Math.min(10000,timeoutMs)))});
     if(response.status===304){if(!loaded)throw new Error('Unsolicited 304');return map;}
     if(response.status!==200){await response.body?.cancel();throw new Error('Redirect map unavailable');}
     data=await responseJSON(response);
     const value=response.headers.get('etag')||'';nextETag=/^(?:W\/)?"[\x21\x23-\x7e]{0,240}"$/.test(value)?value:'';
    }
    assertAbsoluteConfiguration(data);
    const candidate=validatePatterns(compileRedirectMap(data,{allowedHosts:[...hosts],...routeOptions}));
    map=candidate;etag=nextETag;loaded=true;
   } catch(error) {
    warningCount++;try{warn({code:'public_redirect_refresh_failed',count:warningCount});}catch{}
    if(initial&&error instanceof RedirectStartupError)throw error;
   } finally {expires=now()+ttl;pending=undefined;}
   if(again){again=false;return refresh({force:true});}
   return map;
  })();
  return pending;
 }
 const ready=refresh({initial:true});ready.catch(()=>{});
 if(autoRefresh&&(file||endpoint))ready.then(()=>{if(!closed){timer=setInterval(()=>{void refresh().catch(()=>{});},ttl);timer.unref?.();}}).catch(()=>{});
 const handler=async(request,respond)=>{
  if(!['GET','HEAD'].includes(request.method))return false;
  const raw=request.rawUrl??(request.url.pathname+request.url.search);
  if(isJunkPath(raw)){respond(404,'text/plain; charset=utf-8','Not found');return true;}
  // Never await network/disk refresh in a request; stable last-good rules win.
  if(now()>=expires)void refresh().catch(()=>{});
  const key=normalizeRequestPath(raw);
  const url=new URL(request.url);if(key)url.pathname=key;
  let rule=key?map.get(key):undefined;
  if(!rule) {
   const match=configuredPattern(url);if(!match)return false;
   let value=match.slug||match.page;
   if(match.kind==='legacyId') {
    if(!resolveLegacyId)return false;
    let article;try{article=await resolveLegacyId(match.id);}catch{return false;}
    if(article?.status!=='published'||String(article.legacyId)!==match.id||typeof article.slug!=='string'||article.slug.length>160||!SLUG.test(article.slug))return false;
    value=article.slug;
   }
   const template=templates.get(match.kind);let to;
   try{to=safeRedirectTarget(template.replace(match.kind==='page'?'{page}':'{slug}',value||''),{allowedHosts:hosts});canonicalDestination(to,routeOptions);}catch{return false;}
   const path=targetPath(to,siteUrl),targetURL=new URL(to,siteUrl||'https://public.invalid');
   if((path&&(map.has(path)||configuredPattern(targetURL)))||targetURL.pathname+targetURL.search===url.pathname+url.search)return false;
   rule={status:301,to};
  }
  respond(rule.status,'text/plain; charset=utf-8',rule.status===410?'Gone':'Moved',{...(rule.to?{Location:rule.to}:{}),'Cache-Control':'public, max-age=300'});return true;
 };
 handler.ready=ready;handler.refresh=()=>refresh({force:true});handler.settled=()=>pending||Promise.resolve(map);
 handler.diagnostics=()=>({warningCount,loaded,ruleCount:map.size,refreshing:Boolean(pending)});
 handler.close=()=>{closed=true;clearInterval(timer);};
 return handler;
}
class RedirectStartupError extends Error {}

export const DEFAULT_LEGACY_SITE_HOSTS='churchtimesnigeria.org,churchtimesnigeria.com';
const LEGACY_HOST=/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/**
 * Old site hosts (apps/cms/docs/legacy-hosts.md): .org, .com and the www. forms of .org, .com and .net mean the primary host.
 * Returns (hostHeader, rawUrl) => absolute https URL on the primary host with the SAME path and query, or '' for no redirect.
 * The target host always comes from PUBLIC_SITE_URL, never from the incoming Host header. Runs before any rule.
 */
export function legacyHostRedirector({siteUrl,legacySiteHosts}={}) {
 let primary='',origin='';
 try{const url=new URL(siteUrl);if(url.protocol==='https:'&&!url.username&&!url.password){primary=url.hostname.toLowerCase();origin='https://'+url.host;}}catch{}
 if(!primary)return()=>'';
 const names=String(legacySiteHosts||DEFAULT_LEGACY_SITE_HOSTS).split(',').map(v=>v.trim().toLowerCase()).filter(Boolean);
 for(const name of names)if(!LEGACY_HOST.test(name))throw new Error('LEGACY_SITE_HOSTS must be a comma list of bare host names');
 const bare=primary.replace(/^www\./,'');
 const hosts=new Set();
 for(const name of [...names,bare]){hosts.add(name);hosts.add('www.'+name.replace(/^www\./,''));}
 hosts.delete(primary);
 return (hostHeader,rawUrl)=>{
  if(typeof hostHeader!=='string'||typeof rawUrl!=='string'||!rawUrl.startsWith('/')||rawUrl.startsWith('//'))return '';
  const host=hostHeader.toLowerCase().replace(/:\d+$/,'').replace(/\.$/,'');
  return hosts.has(host)?origin+rawUrl:'';
 };
}
