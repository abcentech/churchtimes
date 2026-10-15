import {publicSkipHTML} from './public-skip-link.mjs';
import {gzipSync} from 'node:zlib';
// Compress text at the optional Node public host; no application JS changes.
export function createPublicResponder(req,res) {
  return (status,type,body,headers={})=>{
    if(type.startsWith('text/html'))body=publicSkipHTML(Buffer.isBuffer(body)?body.toString('utf8'):body,req.url);
    const buffer=Buffer.isBuffer(body)?body:Buffer.from(body || '');
    const gzip=/\bgzip\b(?!\s*;\s*q=0(?:\.0*)?(?:\s*(?:,|$)))/.test(req.headers['accept-encoding'] || '') && /^(text\/|application\/(?:json|xml|rss\+xml))/.test(type) && buffer.length>=1024;
    const output=gzip?gzipSync(buffer):buffer;
    res.writeHead(status,{'Content-Type':type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store',Vary:'Accept-Encoding',...headers,...(gzip?{'Content-Encoding':'gzip'}:{}),'Content-Length':output.length});
    res.end(req.method==='HEAD'?undefined:output);
  };
}
