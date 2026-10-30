import test from 'node:test';
import assert from 'node:assert/strict';
import {applyShareCardMeta,shareCardMode,shareCardUrl} from '../tools/public-routes/share-card-meta.mjs';
import {replaceSocialHTML} from '../src/lib/public-metadata.js';

const base='<!doctype html><html><head><title>x</title></head><body></body></html>';
const article={slug:'synod-opens',title:'Synod "opens" <now>',excerpt:'E',publishedAt:'2026-10-30T05:00:00.000Z',updatedAt:'2026-10-30T06:00:00.000Z',featuredImage:null};
const CMS='https://cms.churchtimes.example';

test('mode is off unless explicitly fallback or always',()=>{
  assert.equal(shareCardMode(undefined),'off');assert.equal(shareCardMode('true'),'off');
  assert.equal(shareCardMode('fallback'),'fallback');assert.equal(shareCardMode('always'),'always');
});

test('card URL is versioned and only built for safe slugs and CMS origins',()=>{
  assert.equal(shareCardUrl(article,CMS),'https://cms.churchtimes.example/api/public/share-card/synod-opens.png?v=2026-10-30T06%3A00%3A00.000Z');
  assert.equal(shareCardUrl({...article,slug:'../x'},CMS),'');
  assert.equal(shareCardUrl(article,'javascript:alert(1)'),'');
  assert.equal(shareCardUrl(article,''),'');
});

test('off: page unchanged; fallback: card only when there is no featured image',()=>{
  const page=replaceSocialHTML(base,article,'https://churchtimes.example/synod-opens/');
  assert.equal(applyShareCardMeta(page,article,{cmsUrl:CMS,mode:'off'}),page);
  const withCard=applyShareCardMeta(page,article,{cmsUrl:CMS,mode:'fallback'});
  assert.match(withCard,/property="og:image" content="https:\/\/cms\.churchtimes\.example\/api\/public\/share-card\/synod-opens\.png\?v=/);
  assert.match(withCard,/property="og:image:width" content="1200"/);
  assert.match(withCard,/name="twitter:image" content="https:\/\/cms/);
  assert.match(withCard,/name="twitter:card" content="summary_large_image"/);
  assert.match(withCard,/property="og:image:alt" content="Synod &quot;opens&quot; &lt;now&gt;"/);
  const photo='<!doctype html><html><head><meta property="og:image" content="https://cms.example/media/a.jpg"></head></html>';
  assert.equal(applyShareCardMeta(photo,article,{cmsUrl:CMS,mode:'fallback'}),photo);
});

test('always: replaces the photo tags so exactly one og:image remains',()=>{
  const photo='<!doctype html><html><head><meta data-public-metadata property="og:image" content="https://cms.example/media/a.jpg"><meta data-public-metadata property="og:image:width" content="800"><meta data-public-metadata name="twitter:card" content="summary_large_image"></head></html>';
  const out=applyShareCardMeta(photo,article,{cmsUrl:CMS,mode:'always'});
  assert.equal(out.match(/property="og:image"/g).length,1);
  assert.equal(out.match(/property="og:image:width"/g).length,1);
  assert.doesNotMatch(out,/media\/a\.jpg/);
});
