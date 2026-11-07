import test from 'node:test';
import assert from 'node:assert/strict';
import {shareTargets,shareBarHTML} from '../src/lib/share-bar.js';
import {SOCIAL_LINKS,SOCIAL_SAME_AS,socialLinksHTML} from '../src/lib/social-links.js';
import {articleCanonical,articleSchema} from '../src/lib/public-routes.js';

const url='https://example.org/some-story/';
const by=(targets,id)=>targets.find(t=>t.id===id).href;

test('share links escape ampersands, quotes and non-ASCII titles',()=>{
  const title='Faith & "Hope": Ọ̀gbẹ̀ni\'s <b>story</b> — 50%';
  const targets=shareTargets({title,url});
  const enc=encodeURIComponent(title);
  assert.equal(by(targets,'x'),`https://twitter.com/intent/tweet?text=${enc}&url=${encodeURIComponent(url)}`);
  assert.ok(by(targets,'telegram').endsWith(`&text=${enc}`));
  for(const t of targets) {
    assert.doesNotMatch(t.href,/[<>" ]/,t.id);
    assert.equal(new URL(t.href).protocol,t.id==='email'?'mailto:':'https:');
  }
  assert.ok(new URL(by(targets,'whatsapp')).searchParams.get('text')===`${title} ${url}`);
  assert.ok(new URL(by(targets,'facebook')).searchParams.get('u')===url);
  assert.ok(new URL(by(targets,'email')).searchParams.get('subject')===title);
});

test('share bar HTML attribute-escapes the title and url and uses safe rel',()=>{
  const html=shareBarHTML({title:'A "quote" & <script>',url});
  assert.doesNotMatch(html,/<script>/);
  assert.match(html,/data-share-title="A &quot;quote&quot; &amp; &lt;script&gt;"/);
  assert.match(html,/rel="noopener noreferrer"/);
  assert.match(html,/aria-live="polite"/);
});

test('share URL follows the article canonical for a base path and the /{slug}/ template',()=>{
  const canonical=articleCanonical('my-story',{siteUrl:'https://churchtimesnigeria.net',basePath:'/',articlePathTemplate:'/{slug}/'});
  assert.equal(canonical,'https://churchtimesnigeria.net/my-story/');
  assert.equal(articleCanonical('my-story',{siteUrl:'https://x.org',basePath:'/pub/',articlePathTemplate:'/{slug}/'}),'https://x.org/pub/my-story/');
  assert.ok(by(shareTargets({title:'T',url:canonical}),'facebook').includes(encodeURIComponent(canonical)));
});

test('social links are https, unique and rendered with accessible names',()=>{
  assert.equal(SOCIAL_LINKS.length,7);
  assert.equal(new Set(SOCIAL_SAME_AS).size,7);
  for(const l of SOCIAL_LINKS)assert.equal(new URL(l.url).protocol,'https:');
  const html=socialLinksHTML();
  for(const l of SOCIAL_LINKS)assert.ok(html.includes(`aria-label="Church Times Nigeria on ${l.name}"`));
  assert.equal(html.match(/rel="noopener noreferrer me"/g).length,7);
});

test('article schema carries Organization sameAs only when supplied',()=>{
  const a={title:'T',excerpt:'E'};
  assert.equal(articleSchema(a,'').publisher.sameAs,undefined);
  assert.deepEqual(articleSchema(a,'',{sameAs:SOCIAL_SAME_AS}).publisher.sameAs,SOCIAL_SAME_AS);
});
