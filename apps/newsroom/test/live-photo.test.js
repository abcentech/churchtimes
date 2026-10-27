import test from 'node:test';
import assert from 'node:assert/strict';
import { livePhotoHtml, liveUpdatePayload } from '../src/live-photo.js';
import { resolveAssetUrl } from '../src/asset-url.js';

const CMS = 'https://cms.example.org';
const safe = url => resolveAssetUrl(url, CMS);

test('live update payload: image is the numeric media id and only present when there is a photo', () => {
  assert.deepEqual(liveUpdatePayload({ eventId: '3', body: 'Text' }), { event: 3, body: 'Text' });
  assert.deepEqual(liveUpdatePayload({ eventId: '3', body: 'Text', imageId: null }), { event: 3, body: 'Text' });
  assert.deepEqual(liveUpdatePayload({ eventId: '3', body: 'Text', imageId: '' }), { event: 3, body: 'Text' });
  assert.deepEqual(liveUpdatePayload({ eventId: '3', body: 'Text', imageId: '17' }), { event: 3, body: 'Text', image: 17 });
  assert.deepEqual(
    liveUpdatePayload({ eventId: 3, body: 'Text', publishNow: true, imageId: 17 }),
    { event: 3, body: 'Text', status: 'approved', image: 17 }
  );
  assert.strictEqual(liveUpdatePayload({ eventId: 3, body: 'x', imageId: '17' }).image, 17);
});

test('photo thumbnail: root-relative and same-CMS-origin URLs render, alt is escaped', () => {
  const rel = livePhotoHtml({ thumbUrl: '/api/media/file/a.png', alt: 'Delegates "vote"' }, safe);
  assert.equal(rel, '<img class="live-photo-thumb" data-testid="live-update-photo" src="https://cms.example.org/api/media/file/a.png" alt="Delegates &quot;vote&quot;" loading="lazy">');
  const abs = livePhotoHtml({ url: 'https://cms.example.org/api/media/file/b.png', alt: '<script>alert(1)</script>' }, safe);
  assert.match(abs, /src="https:\/\/cms\.example\.org\/api\/media\/file\/b\.png"/);
  assert.match(abs, /alt="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
  assert.ok(!abs.includes('<script'));
});

test('photo thumbnail: unsafe or missing URLs produce no <img> at all', () => {
  for (const url of [
    'javascript:alert(1)', 'data:image/svg+xml,<svg onload=alert(1)>', '//evil.example/x.png', 'https://evil.example/x.png',
    'http://cms.example.org/x.png', '/\\evil.example/x.png', 'ftp://cms.example.org/x.png', '', undefined
  ]) {
    assert.equal(livePhotoHtml({ url, thumbUrl: url, alt: 'x' }, safe), '', String(url));
  }
  assert.equal(livePhotoHtml(null, safe), '');
  assert.equal(livePhotoHtml(undefined, safe), '');
  assert.equal(livePhotoHtml({ url: '/a.png', alt: 'x' }, undefined), '');
});

test('photo thumbnail: falls back to the full URL when the thumbnail URL is unsafe; custom test id; missing alt', () => {
  const html = livePhotoHtml({ thumbUrl: 'javascript:x', url: '/full.png' }, safe, { testid: 'live-update-photo-draft' });
  assert.match(html, /src="https:\/\/cms\.example\.org\/full\.png"/);
  assert.match(html, /data-testid="live-update-photo-draft"/);
  assert.match(html, /alt=""/);
});
