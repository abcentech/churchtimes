import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderArticleContent } from '../src/lib/article-content.js';

const base = 'https://cms.example.test';
const block = fields => ({root:{type:'root',children:[{type:'block',fields:{blockType:'audioVideo',title:'Choir',...fields}}]}});
const media = (mimeType, name = 'a.mp4') => ({mimeType, url: `${base}/api/media/file/${name}`});
const render = fields => renderArticleContent(block(fields), {baseUrl: base});

test('renders video with poster, caption, transcript, no autoplay', () => {
  const html = render({kind:'video',media:media('video/mp4'),poster:media('image/jpeg','p.jpg'),caption:'A <b>cap</b>',transcriptUrl:'https://example.org/t'});
  assert.match(html, /<video controls preload="none" src="https:\/\/cms\.example\.test\/api\/media\/file\/a\.mp4" poster="[^"]*p\.jpg"/);
  assert.match(html, /A &lt;b&gt;cap&lt;\/b&gt;/);
  assert.match(html, /href="https:\/\/example\.org\/t" rel="noopener noreferrer">Transcript/);
  assert.doesNotMatch(html, /autoplay/);
});
test('renders audio', () => {
  const html = render({kind:'audio',media:media('audio/mpeg','a.mp3')});
  assert.match(html, /<audio controls preload="none" src="[^"]*a\.mp3"/);
});
test('rejects foreign origin, wrong path, wrong mime, bare id', () => {
  assert.equal(render({kind:'video',media:{mimeType:'video/mp4',url:'https://evil.test/api/media/file/a.mp4'}}), '');
  assert.equal(render({kind:'video',media:{mimeType:'video/mp4',url:`${base}/other/a.mp4`}}), '');
  assert.equal(render({kind:'video',media:media('audio/mpeg')}), '');
  assert.equal(render({kind:'video',media:123,sourceUrl:'https://example.org/v'}), '');
  assert.equal(render({kind:'film',media:media('video/mp4')}), '');
});
test('legacy sourceUrl falls back to a safe link; unsafe ones render nothing', () => {
  const html = render({kind:'video',sourceUrl:'https://example.org/v?a=1&b=2',title:'T"<x>'});
  assert.match(html, /<a href="https:\/\/example\.org\/v\?a=1&amp;b=2" rel="noopener noreferrer">Watch: T&quot;&lt;x&gt;<\/a>/);
  assert.doesNotMatch(html, /<video|<audio/);
  for (const u of ['javascript:alert(1)','//evil.test/x','https://u:p@x.test/','data:text/html,x']) assert.equal(render({kind:'audio',sourceUrl:u}), '');
});
test('unsafe transcript and poster are dropped, title escaped', () => {
  const html = render({kind:'video',title:'<img onerror=1>',media:media('video/webm'),poster:{mimeType:'image/svg+xml',url:`${base}/api/media/file/p.svg`},transcriptUrl:'javascript:1'});
  assert.doesNotMatch(html, /poster=|Transcript|<img/);
  assert.match(html, /&lt;img onerror=1&gt;/);
});
