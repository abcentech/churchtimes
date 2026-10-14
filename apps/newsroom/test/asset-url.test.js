import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAssetUrl } from '../src/asset-url.js';

const CMS = 'https://cms.example.org';

test('root-relative CMS media resolves against the CMS origin', () => {
  assert.equal(resolveAssetUrl('/api/media/file/a.png', CMS), 'https://cms.example.org/api/media/file/a.png');
  assert.equal(resolveAssetUrl('/api/media/file/a.png', '', 'https://news.example.org'), '/api/media/file/a.png');
});

test('same-origin absolute http(s) URLs are accepted', () => {
  assert.equal(resolveAssetUrl('https://cms.example.org/m/a.png', CMS), 'https://cms.example.org/m/a.png');
  assert.equal(resolveAssetUrl('https://news.example.org/m/a.png', '', 'https://news.example.org'), 'https://news.example.org/m/a.png');
});

test('protocol-relative, backslash and cross-origin URLs are rejected', () => {
  for (const bad of [
    '//evil.example/x.png', '/\\evil.example/x.png', '\\\\evil.example/x.png', '/\\/evil.example', '\\/evil.example',
    'https://evil.example/x.png', 'http://cms.example.org/x.png', 'https://cms.example.org.evil.example/x.png',
    'https://cms.example.org@evil.example/x.png', 'javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'ftp://cms.example.org/x',
    'relative/path.png', '/ok\n//evil', '/tab\t/x', ' /x', '', null, undefined, 42, {}
  ]) {
    assert.equal(resolveAssetUrl(bad, CMS), '', `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(resolveAssetUrl('https://evil.example/x.png', '', 'https://news.example.org'), '');
  assert.equal(resolveAssetUrl('https://news.example.org/x.png', ''), ''); // unknown page origin: nothing absolute is trusted
});
