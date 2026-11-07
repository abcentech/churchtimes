import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest import mock
import urllib.error

spec = importlib.util.spec_from_file_location('recover', Path(__file__).parents[1] / 'recover.py')
r = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = r
spec.loader.exec_module(r)
ORIGINAL = 'http://churchtimesnigeria.org/story/'
STAMP = '20150227141508'
HTML = b'<title>Archive story</title><article><h1>A story</h1><p>This is enough original article body for a meaningful extraction.</p><img src="/wp-content/uploads/photo.jpg"><img src="https://example.com/foreign.jpg"></article>'

def row(stamp=STAMP):
    return dict(zip(r.FIELDS, (stamp, ORIGINAL, '200', 'text/html', 'ia-digest', '100')))

def response(address, data=HTML, mime='text/html'):
    return r.Response(address, 200, {'content-type': mime}, data)

class Fake:
    def __init__(self, answers): self.answers, self.calls = list(answers), []
    def get(self, address):
        self.calls.append(address)
        if not self.answers: raise AssertionError('Unexpected request: ' + address)
        answer = self.answers.pop(0)
        if isinstance(answer, Exception): raise answer
        return answer(address) if callable(answer) else answer

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='archive-test-')
        self.root = Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def recovery(self, answers=()): return r.Recovery(self.root, Fake(answers))
    def test_dry_run_no_io(self):
        store = self.root / 'absent'
        with mock.patch.object(r.Transport, 'get', side_effect=AssertionError('network')), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(r.main(['collect', '--store', str(store), '--dry-run']), 0)
        self.assertFalse(store.exists())
        self.assertEqual(json.loads(out.getvalue())['writes'], 0)
    def test_reject_git_and_traversal_storage(self):
        with self.assertRaises(ValueError): r.store_path(r.REPO / 'raw')
        (self.root / '.git').mkdir(); (self.root / '.git/HEAD').write_text('ref: refs/heads/main')
        with self.assertRaises(ValueError): r.store_path(self.root / 'raw')
    def test_manifest_path_and_symlink_escape(self):
        rec = self.recovery()
        for bad in ('../secret', '/tmp/secret'):
            with self.assertRaises(ValueError): rec.path(bad)
        (self.root / 'escape').symlink_to('/tmp', target_is_directory=True)
        with self.assertRaises(ValueError): rec.path('escape/file')
    def test_cdx_resume_and_checkpoint(self):
        page = json.dumps([list(r.FIELDS), list(row().values())]).encode() + b'\n\nopaque-token'
        rec = self.recovery([lambda a: response(a, page, 'application/json')])
        rec.index(r.DOMAINS[0], max_pages=1)
        self.assertFalse(rec.state['domains'][r.DOMAINS[0]]['complete'])
        resumed = r.Recovery(self.root, Fake([lambda a: response(a, b'[]', 'application/json')]))
        resumed.index(r.DOMAINS[0])
        self.assertIn('resumeKey=opaque-token', resumed.transport.calls[0])
        self.assertTrue(resumed.state['domains'][r.DOMAINS[0]]['complete'])
        resumed.index(r.DOMAINS[0]); self.assertEqual(len(resumed.transport.calls), 1)
    def test_invalid_cdx_is_not_counted(self):
        for data in (b'<html>proxy error</html>', b'[["timestamp","original"]]', json.dumps([list(r.FIELDS), list(dict(row(), original='https://evil.test/a').values())]).encode()):
            with self.assertRaises(ValueError): r.parse_cdx(data)
        rec = self.recovery([lambda a: response(a, b'<html>Error</html>')]); rec.index(r.DOMAINS[0])
        self.assertEqual(rec.report()['observed_unique_urls'], 0)
        self.assertTrue(list((self.root / 'indexes').rglob('*.txt')))
    def test_success_sha_resume_and_corruption_repair(self):
        rec = self.recovery([lambda a: response(a)])
        saved = rec.capture(row()); self.assertEqual(saved['file']['sha256'], r.sha(HTML))
        resumed = r.Recovery(self.root, Fake([])); resumed.capture(row())
        self.assertEqual(resumed.transport.calls, [])
        (self.root / saved['file']['path']).write_bytes(b'corrupt')
        resumed.checksums(); self.assertIn(saved['file']['path'], resumed.verify())
        repaired = r.Recovery(self.root, Fake([lambda a: response(a)])); repaired.capture(row())
        self.assertTrue(repaired.valid_cached(repaired.state['records'][next(iter(repaired.state['records']))]))
        self.assertTrue(list((self.root / 'quarantine').glob('corrupt-*')))
    def test_proxy_block_is_unknown_not_missing(self):
        rec = self.recovery([r.FetchError('proxy-blocked', 'Tunnel connection failed: 403 Forbidden', tunnel_status=403)])
        failed = rec.capture(row())
        self.assertEqual(failed['availability'], 'unknown'); self.assertIsNone(failed['confidence'])
        self.assertIsNone(failed['failure']['origin_http_status'])
        self.assertEqual(rec.report()['confirmed_replay_404s'], 0)
        self.assertEqual(rec.report()['unique_raw_files'], 0)
    def test_origin_404_is_explicit(self):
        rec = self.recovery([r.FetchError('http-error', 'Not found', status=404)])
        self.assertEqual(rec.capture(row())['confidence'], 'missing')
        self.assertEqual(rec.report()['confirmed_replay_404s'], 1)
    def test_archive_error_body_is_quarantined(self):
        rec = self.recovery([lambda a: response(a, b'The Wayback Machine has not archived that URL')])
        failed = rec.capture(row()); self.assertIn('quarantine', failed)
        self.assertEqual(rec.report()['unique_raw_files'], 0)
    def test_redirect_to_other_original_rejected(self):
        rec = self.recovery([response(r.replay_url(ORIGINAL + 'other', STAMP))])
        self.assertEqual(rec.capture(row())['failure']['kind'], 'different-original')
    def test_embedded_media_download_and_external_exclusion(self):
        rec = self.recovery([lambda a: response(a), lambda a: response(a, b'\xff\xd8\xffJPEG', 'image/jpeg')])
        rec.state['captures']['one'] = row(); rec.download(max_captures=3)
        self.assertEqual(len(rec.transport.calls), 2)
        self.assertIn('/wp-content/uploads/photo.jpg', rec.transport.calls[1])
        self.assertEqual(rec.report()['downloaded_asset_records'], 1)
        self.assertEqual(rec.report()['verified_full_articles'], 0)
    def test_fallback_versions_and_conflict_reporting(self):
        rec = self.recovery([r.FetchError('http-error', 'gone', status=404), lambda a: response(a), lambda a: response(a, b'image', 'application/octet-stream')])
        rec.state['captures'] = {'old': row('20140227141508'), 'new': row()}
        rec.download(max_captures=2)
        self.assertEqual(rec.report()['saved_capture_records'], 1)
        self.assertEqual(rec.report()['failed_capture_attempts'], 1)
        self.assertTrue(rec.report()['download_limit_reached'])
    def test_multiple_article_listing_not_counted(self):
        page = b'<article><p>A long teaser from the first original news story.</p></article><article><p>A long teaser from the second original news story.</p></article>'
        self.assertFalse(r.extract_article(page, ORIGINAL)['is_article_candidate'])
    def test_extraction_partial_preserves_text_and_unconfirmed_dates(self):
        result = r.extract_article(HTML + b'<script>alert("do not execute")</script>', ORIGINAL)
        self.assertTrue(result['is_article_candidate']); self.assertIsNone(result['publication_date'])
        self.assertEqual(result['confidence'], 'partial'); self.assertNotIn('alert', result['article_body'])
        malformed = b'<script type="application/ld+json">{"@type":null}</script>'
        self.assertFalse(r.extract_article(malformed, ORIGINAL)['is_article_candidate'])
    def test_legacy_wordpress_byline_date_shortlink_and_entry(self):
        page = b'<link rel="shortlink" href="http://churchtimesnigeria.org/?p=17"><span class="meta_date">June 01, 2011</span><span class="meta_author">Reporter Name</span><div class="entry clearfix"><p>An original interview with enough reporting to preserve here.</p></div>'
        result = r.extract_article(page, ORIGINAL)
        self.assertTrue(result['is_article_candidate'])
        self.assertEqual(result['author'], 'Reporter Name')
        self.assertEqual(result['publication_date'], '2011-06-01')
        self.assertEqual(result['source_date_text'], 'June 01, 2011')
        self.assertEqual(result['wordpress_post_id'], '17')
    def test_legacy_table_content_preserves_lead_without_p(self):
        page = b'<table><tr><td class="Content"><div>Original article introduction without a paragraph tag.</div></td></tr><tr><td class="Content"><p>The body continues as a second preserved paragraph.</p></td></tr></table>'
        result = r.extract_article(page, 'http://churchtimesnigeria.com:80/columnist_example.htm')
        self.assertTrue(result['is_article_candidate'])
        self.assertIn('Original article introduction', result['article_body'])
        self.assertIn('The body continues', result['article_body'])
        self.assertFalse(r.extract_article(page, 'http://churchtimesnigeria.com:80/directory_news.htm')['is_article_candidate'])
    def test_persisted_cooldown_prevents_network_after_restart(self):
        rec = self.recovery([r.FetchError('rate-limited', '429', status=429, retry_after=120)])
        with self.assertRaises(r.FetchError): rec.get('https://archive.org/', 'test')
        resumed = r.Recovery(self.root, Fake([]))
        with self.assertRaises(r.FetchError) as caught: resumed.get('https://archive.org/wayback/available', 'test')
        self.assertEqual(caught.exception.kind, 'rate-limit-deferred')
        self.assertEqual(resumed.transport.calls, [])
    def test_conflicting_versions_remain_separate(self):
        rec = self.recovery([lambda a: response(a), lambda a: response(a, HTML + b' revised')])
        rec.capture(row()); rec.capture(row('20140227141508'))
        self.assertEqual(rec.report()['conflicting_url_versions'], [ORIGINAL])
        self.assertEqual(rec.report()['saved_capture_records'], 2)
    def test_mime_signatures_reject_disguised_html(self):
        for mime in ('image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon'):
            self.assertTrue(r.media_mismatch(mime, b'<html>unrelated proxy error</html>'))
        self.assertFalse(r.media_mismatch('image/jpeg', b"\xff\xd8\xffimage"))
    def test_error_as_embedded_image_is_quarantined(self):
        rec = self.recovery([lambda a: response(a, b'<html>generic unavailable page</html>', 'image/jpeg')])
        asset = dict(row(), original='http://churchtimesnigeria.org/photo.jpg', mimetype='image/jpeg')
        record = rec.capture(asset)
        self.assertEqual(record['status'], 'failed')
        self.assertEqual(rec.report()['downloaded_asset_records'], 0)
    def test_malformed_attributes_and_timestamp_are_safe(self):
        result = r.extract_article(b'<article class><p>Preserved text with a valueless HTML class attribute.</p></article>', ORIGINAL)
        self.assertTrue(result['is_article_candidate'])
        bad = row('20159999999999')
        with self.assertRaises(ValueError): r.parse_cdx(json.dumps([list(r.FIELDS), list(bad.values())]).encode())
    def test_availability_does_not_overwrite_cdx_provenance(self):
        original = r.LEADS[0]['original']
        indexed = dict(row(), original=original)
        available = {'archived_snapshots': {'closest': {'available': True, 'status': '200', 'timestamp': STAMP, 'url': r.replay_url(original, STAMP)}}}
        rec = self.recovery([lambda a: response(a, json.dumps(available).encode()), *[lambda a: response(a, b'{}') for _ in range(3)], lambda a: response(a), lambda a: response(a, original.encode())])
        key = r.sha((original + '\n' + STAMP).encode()); rec.state['captures'][key] = indexed
        rec.citations()
        self.assertEqual(rec.state['captures'][key]['digest'], 'ia-digest')
        self.assertNotIn('source', rec.state['captures'][key])
    def test_dated_article_is_distinct_from_calendar_index(self):
        self.assertTrue(r.extract_article(HTML, 'http://churchtimesnigeria.org/2014/05/09/story/')['is_article_candidate'])
        self.assertFalse(r.extract_article(HTML, 'http://churchtimesnigeria.org/2014/05/09/')['is_article_candidate'])
        self.assertFalse(r.extract_article(HTML, 'http://churchtimesnigeria.org/page/2/')['is_article_candidate'])
    def test_twentyten_metadata_and_heading_override_site_title(self):
        page = b'<title>Site title</title><h1>Site brand</h1><h2 class="entry-title">Original article title</h2><span class="entry-date">May 9, 2014</span><span class="author vcard"><a>Original Reporter</a></span><div class="entry-content"><p>Original archived interview text with enough body for extraction.</p></div>'
        result = r.extract_article(page, ORIGINAL)
        self.assertEqual(result['title'], 'Original article title')
        self.assertEqual(result['author'], 'Original Reporter')
        self.assertEqual(result['publication_date'], '2014-05-09')
    def test_observed_404_not_repeated_without_explicit_retry(self):
        rec = self.recovery([r.FetchError('http-error', 'missing', status=404)])
        rec.capture(row())
        resumed = r.Recovery(self.root, Fake([])); resumed.capture(row())
        self.assertEqual(resumed.transport.calls, [])
        retried = r.Recovery(self.root, Fake([lambda a: response(a)]), retry_failed=True)
        self.assertEqual(retried.capture(row())['status'], 'saved')
    def test_shared_unindexed_asset_attempted_once_per_url(self):
        rec = self.recovery([lambda a: response(a), lambda a: response(a), r.FetchError('http-error', 'asset missing', status=404)])
        other = dict(row('20140227141508'), original=ORIGINAL + 'other')
        rec.state['captures'] = {'first': row(), 'second': other}
        rec.download(max_captures=10)
        self.assertEqual(len(rec.transport.calls), 3)
        self.assertEqual(rec.report()['unrecovered_embedded_asset_urls'], 1)
    def test_index_checksum_cannot_be_hidden_by_regenerating_catalog(self):
        page = json.dumps([list(r.FIELDS), list(row().values())]).encode()
        rec = self.recovery([lambda a: response(a, page)])
        rec.index(r.DOMAINS[0])
        entry = rec.state['domains'][r.DOMAINS[0]]['pages'][0]
        (self.root / entry['path']).write_bytes(b'tampered index')
        rec.checksums()
        self.assertIn(entry['path'], rec.verify())
    def test_legacy_space_and_unicode_media_urls_are_encoded(self):
        original = 'http://churchtimesnigeria.com:80/picture_library/columinist akindayo.jpg'
        address = r.replay_url(original, STAMP)
        self.assertIn('columinist%20akindayo.jpg', address)
        self.assertNotIn(' ', address)
        rec = self.recovery([lambda a: response(a, b"\xff\xd8\xffimage", 'image/jpeg')])
        self.assertEqual(rec.capture({'original': original, 'timestamp': STAMP})['status'], 'saved')
        parsed = r.extract_article(b'<img src="/picture_library/photo name.jpg#view">', ORIGINAL)
        self.assertEqual(parsed['assets'][0]['original_url'], 'http://churchtimesnigeria.org/picture_library/photo%20name.jpg')
        self.assertIn('%C3%A9', r.replay_url('http://churchtimesnigeria.org/café.jpg', STAMP))
    def test_unknown_revisit_status_is_checked_as_fallback(self):
        rec = self.recovery([lambda a: response(a, b"\xff\xd8\xffimage", 'image/jpeg')])
        unknown = dict(row(), original='http://churchtimesnigeria.org/photo.jpg', statuscode='-', mimetype='warc/revisit')
        rec.state['captures']['unknown'] = unknown; rec.download()
        self.assertEqual(rec.report()['downloaded_media_records'], 1)
    def test_current_posts_public_and_sitemap_resume(self):
        posts = [{'id': i, 'status': 'publish'} for i in range(100)]
        rec = self.recovery([lambda a: r.Response(a, 200, {'x-wp-totalpages': '1'}, json.dumps(posts).encode()), r.FetchError('proxy-blocked', 'blocked'), r.FetchError('proxy-blocked', 'blocked')])
        rec.current_inventory(); self.assertTrue(rec.state['current']['rest_complete'])
        self.assertEqual(rec.report()['current_published_posts_observed'], 100)
        self.assertEqual(len(rec.state['current']['sitemap_pending']), 2)
        resumed = r.Recovery(self.root, Fake([lambda a: response(a, b'<urlset><url><loc>https://churchtimesnigeria.net/story/</loc></url></urlset>'), lambda a: response(a, b'<sitemapindex/>')]))
        resumed.current_inventory(); self.assertEqual(resumed.state['current']['sitemap_pending'], [])
        self.assertEqual(resumed.report()['current_sitemap_urls_observed'], 1)
    def test_nonpublished_current_posts_rejected(self):
        rec = self.recovery([lambda a: response(a, b'[{"id":1,"status":"draft"}]'), r.FetchError('network-error', 'blocked'), r.FetchError('network-error', 'blocked')])
        rec.current_inventory(); self.assertEqual(rec.report()['current_published_posts_observed'], 0)
    def test_package_and_tamper_detection(self):
        rec = self.recovery([lambda a: response(a)]); record = rec.capture(row())
        r.atomic(self.root / 'coverage.json', r.json_bytes(rec.report()))
        bundle = rec.package(); self.assertEqual(bundle.stat().st_mode & 0o777, 0o600)
        with tarfile.open(bundle) as archive: self.assertIn('checksums.json', archive.getnames())
        self.assertEqual(rec.verify(), [])
        (self.root / record['file']['path']).write_bytes(b'bad')
        with self.assertRaises(ValueError): rec.package()

class TransportTests(unittest.TestCase):
    def test_private_routes_and_unapproved_hosts(self):
        for address in ('https://churchtimesnigeria.net/wp-admin/', 'https://churchtimesnigeria.net/?rest_route=/wp/v2/users', 'https://evil.test/', 'http://web.archive.org/', 'https://user:password@archive.org/'):
            with self.assertRaises(r.FetchError): r.request_ok(address)
    def test_proxy_403_not_origin_or_retried(self):
        opener = mock.Mock(); opener.open.side_effect = urllib.error.URLError('Tunnel connection failed: 403 Forbidden')
        with self.assertRaises(r.FetchError) as caught: r.Transport(opener=opener, sleeper=lambda _: None).get('https://archive.org/')
        self.assertEqual(opener.open.call_count, 1)
        self.assertEqual(caught.exception.tunnel_status, 403); self.assertIsNone(caught.exception.status)
    def test_retry_after_and_long_cooldown(self):
        opener = mock.Mock(); opener.open.side_effect = urllib.error.HTTPError('https://archive.org/', 429, 'rate limited', {'Retry-After': '120'}, None)
        transport = r.Transport(opener=opener, sleeper=lambda _: self.fail('Long blocking wait'), clock=lambda: 100)
        with self.assertRaises(r.FetchError) as caught: transport.get('https://archive.org/')
        self.assertEqual(caught.exception.retry_after, 120)
        with self.assertRaises(r.FetchError) as deferred: transport.get('https://archive.org/wayback/available')
        self.assertEqual(deferred.exception.kind, 'rate-limit-deferred'); self.assertEqual(opener.open.call_count, 1)
    def test_bounded_size_and_truncation(self):
        for data, declared, kind in ((b'12345', '5', 'too-large'), (b'123', '4', 'truncated')):
            stream = mock.MagicMock(); stream.__enter__.return_value = stream
            stream.status = 200; stream.headers = {'Content-Length': declared}; stream.geturl.return_value = 'https://archive.org/'; stream.read.return_value = data
            opener = mock.Mock(); opener.open.return_value = stream
            with self.assertRaises(r.FetchError) as caught: r.Transport(max_bytes=4, opener=opener).get('https://archive.org/')
            self.assertEqual(caught.exception.kind, kind)
    def test_transient_retry_attempts_are_logged(self):
        stream = mock.MagicMock(); stream.__enter__.return_value = stream
        stream.status = 200; stream.headers = {'Content-Type': 'application/json'}
        stream.geturl.return_value = 'https://archive.org/'; stream.read.return_value = b'{}'
        opener = mock.Mock(); opener.open.side_effect = [urllib.error.HTTPError('https://archive.org/', 429, 'limited', {'Retry-After': '0'}, None), stream]
        transport = r.Transport(opener=opener, sleeper=lambda _: None)
        self.assertEqual(transport.get('https://archive.org/').data, b'{}')
        self.assertEqual([event['origin_http_status'] for event in transport.events], [429, 200])
    def test_retry_after_date(self):
        self.assertEqual(r.retry_seconds('Thu, 01 Jan 1970 00:02:00 GMT', lambda: 100), 20)
        self.assertIsNone(r.retry_seconds('invalid'))

if __name__ == '__main__': unittest.main()
