// Owner-supplied public values only. No scripts, inferred publisher IDs or secrets.
import {escapeAttribute} from '../src/lib/public-metadata.js';
export function publicSEOSettings({adsTxtLine='',searchVerification=''}={}) {
  const line=String(adsTxtLine).trim(),token=String(searchVerification).trim();
  if(line && (/[\r\n]/.test(line) || !/^[a-z0-9.-]+\.[a-z]{2,},\s*[a-z0-9_-]+,\s*(?:DIRECT|RESELLER)(?:,\s*[a-z0-9]+)?$/i.test(line)))throw new Error('PUBLIC_ADS_TXT_LINE must contain one owner-supplied ads.txt publisher record');
  if(token && !/^[a-z0-9_-]{1,200}$/i.test(token))throw new Error('PUBLIC_SEARCH_CONSOLE_VERIFICATION must contain only the owner-supplied verification token');
  return {
    head:token?`<meta name="google-site-verification" content="${escapeAttribute(token)}">`:'',
    route(url,respond) {
      if(url.pathname!=='/ads.txt')return false;
      respond(line?200:404,'text/plain; charset=utf-8',line?line+'\n':'',{'Cache-Control':'public, max-age=60','X-Robots-Tag':'noindex'});return true;
    },
  };
}
