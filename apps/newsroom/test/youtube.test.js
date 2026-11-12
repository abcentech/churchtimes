import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYoutubeInput } from '../../cms/src/lib/youtube.js';
import { lexicalToMarkdown, markdownToLexical, matchYoutubeLine, youtubeToken } from '../src/lexical.js';

const id = 'aB3_deF-123';

test('accepts each normal YouTube link form and keeps valid start times', () => {
  for (const input of [
    id, 'youtube.com/watch?v=' + id, 'youtu.be/' + id, 'https://youtube.com/watch?v=' + id, 'https://www.youtube.com/watch?si=ok&v=' + id,
    'https://m.youtube.com/watch?v=' + id, 'https://youtu.be/' + id + '?si=abc',
    'https://youtube.com/shorts/' + id, 'https://www.youtube.com/live/' + id,
    'https://youtube.com/watch?v=' + id + '&live=1'
  ]) assert.deepEqual(parseYoutubeInput(input), { videoId: id }, input);
  assert.deepEqual(parseYoutubeInput('https://youtu.be/' + id + '?t=1h2m3s&si=abc'), { videoId: id, startSeconds: 3723 });
  assert.deepEqual(parseYoutubeInput('https://youtube.com/watch?v=' + id + '&t=42'), { videoId: id, startSeconds: 42 });
});

test('rejects impostor hosts, invalid links, playlists, times and IDs', () => {
  for (const input of [
    '', 'short', id + 'x', 'https://facebook.com/watch?v=' + id,
    'https://youtube.com.evil.test/watch?v=' + id, 'https://youtube.com@evil.test/watch?v=' + id,
    'javascript://youtube.com/watch?v=' + id, 'https://youtube.com:444/watch?v=' + id,
    'https://youtube.com/playlist?list=PL123', 'https://youtube.com/watch?list=PL123',
    'https://youtu.be/short', 'https://youtube.com/live/' + id + '/extra',
    'https://youtube.com/watch?v=' + id + '&v=' + id,
    'https://youtu.be/' + id + '?t=oops', 'https://youtu.be/' + id + '?t=1&t=2',
    'https://youtu.be/' + id + '?t=99999999999999999'
  ]) assert.equal(parseYoutubeInput(input), null, input);
});

test('video tokens round-trip ID, title and start without losing surrounding body content', () => {
  const token = youtubeToken(id, 'Prayer ] & \\ song', 3723);
  assert.deepEqual(matchYoutubeLine(token), { videoId: id, title: 'Prayer ] & \\ song', startSeconds: 3723 });
  const document = markdownToLexical('Before\n\n' + token + '\n\nAfter');
  assert.equal(document.root.children[1].fields.videoId, id);
  const read = lexicalToMarkdown(document);
  assert.equal(read.lossy, false);
  assert.equal(read.markdown, 'Before\n\n' + token + '\n\nAfter');
  assert.equal(youtubeToken(id, '<script>'), '');
  assert.equal(matchYoutubeLine('![bad](youtube:short)'), null);
  const extra = structuredClone(document);
  extra.root.children[1].fields.url = 'https://bad.test';
  assert.equal(lexicalToMarkdown(extra).lossy, true);
});
