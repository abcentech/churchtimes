import {escapeAttribute} from '../src/lib/public-metadata.js';
// Apply once to HTML responses, including articles, static and error pages.
export function publicSkipHTML(html,requestURL='/') {
  const pathname=new URL(requestURL,'http://public.invalid').pathname;
  const path=pathname.startsWith('//')?'/':pathname;
  return html.replace('class="skip-link" href="#main"',()=>`class="skip-link" href="${escapeAttribute(path)}#main"`)
    .replace(/<main id="main"(?![^>]*\btabindex=)/g,'<main id="main" tabindex="-1"');
}
