#!/usr/bin/env python3
"""Read-only Wayback/current-site inventory; raw material stays outside Git."""
from __future__ import annotations
import argparse
import collections
import dataclasses
import datetime as dt
import email.utils
import hashlib
import http.client
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse as url
import urllib.request
import xml.etree.ElementTree as ET

SCHEMA = 1
DOMAINS = ("churchtimesnigeria.org", "www.churchtimesnigeria.org", "churchtimesnigeria.com", "www.churchtimesnigeria.com")
CURRENT = "https://churchtimesnigeria.net"
ALLOWED = {"web.archive.org", "archive.org", "churchtimesnigeria.net", "www.churchtimesnigeria.net", "en.wikipedia.org"}
REPO = Path(__file__).resolve().parents[2]
FIELDS = ("timestamp", "original", "statuscode", "mimetype", "digest", "length")
LEADS = [
    {"original": "http://churchtimesnigeria.org/bishop-bola-odeleke-my-experience-with-men/", "timestamp": "20150227141508", "citation": "Wikipedia biography of Bola Odeleke (reported in Issue #13)", "citation_url": "https://en.wikipedia.org/wiki/Bola_Odeleke"},
    {"original": "http://churchtimesnigeria.org/?p=32", "citation": "Nairaland, 2012; Pastor Yakubu Abraham interview (Issue #13; thread URL not supplied)"},
    {"original": "http://churchtimesnigeria.org/?p=35", "citation": "Book citation (Issue #13; book identity/URL not supplied)", "reported_title": "The basis of the Christian faith", "reported_publication_date": "2011-08-22"},
    {"original": "http://churchtimesnigeria.org/anglican-bishop-how-ifa-oracle-predicted-the-coming-of-missionaries-to-egbaland/", "citation": "Academic citation (Issue #13; publication URL not supplied)", "reported_publication_date": "2014-05-09"},
]

def now(): return dt.datetime.now(dt.timezone.utc).isoformat()
def sha(data: bytes): return hashlib.sha256(data).hexdigest()
def encoded_uri(value): return url.quote(value, safe=":/?&=%+@!$'()*,-._~;")
def original_ok(value):
    try:
        p = url.urlsplit(value)
        return p.scheme in {"http", "https"} and p.hostname in DOMAINS and not p.username and not p.password
    except (ValueError, TypeError): return False

def store_path(value):
    p = Path(value).expanduser().resolve()
    if p == REPO or REPO in p.parents: raise ValueError("Raw storage must be outside the repository.")
    for parent in (p, *p.parents):
        marker = parent / ".git"
        if marker.is_file() or (marker.is_dir() and (marker / "HEAD").exists()):
            raise ValueError("Raw storage must not be inside any Git checkout.")
    return p

def atomic(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix=".partial-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as out:
            out.write(data); out.flush(); os.fsync(out.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)

def json_bytes(value): return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()

class FetchError(Exception):
    def __init__(self, kind, message, status=None, tunnel_status=None, retry_after=None):
        super().__init__(message)
        self.kind, self.status, self.tunnel_status, self.retry_after = kind, status, tunnel_status, retry_after
    def metadata(self):
        message = re.sub(r"(https?://)[^/\s]+:[^/@\s]+@", r"\1[redacted]@", str(self))
        return {"kind": self.kind, "message": message[:1000], "origin_http_status": self.status, "tunnel_status": self.tunnel_status, "retry_after_seconds": self.retry_after}

@dataclasses.dataclass
class Response:
    final_url: str
    status: int
    headers: dict
    data: bytes

def request_ok(value):
    p = url.urlsplit(value)
    if p.scheme != "https" or p.hostname not in ALLOWED or p.username or p.password:
        raise FetchError("unsafe-destination", "Only approved public HTTPS destinations are allowed.")
    if p.hostname in {"churchtimesnigeria.net", "www.churchtimesnigeria.net"}:
        decoded = url.unquote(p.path + "?" + p.query).lower()
        if any(x in decoded for x in ("wp-admin", "wp-login", "/users", "/settings")):
            raise FetchError("private-route", "Private/admin endpoints are out of scope.")
    return value

class Redirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        newurl = encoded_uri(url.urljoin(req.full_url, newurl))
        if url.urlsplit(newurl).scheme == "http" and url.urlsplit(newurl).hostname in ALLOWED:
            newurl = "https:" + newurl[5:]
        request_ok(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)

def retry_seconds(value, clock=time.time):
    if not value: return None
    value = str(value).strip()
    try:
        n = int(value) if value.isdigit() else int(email.utils.parsedate_to_datetime(value).timestamp() - clock())
        return max(0, n)
    except (TypeError, ValueError, OverflowError): return None

class Transport:
    def __init__(self, delay=2, retries=2, timeout=20, max_bytes=25 * 1024 * 1024, opener=None, sleeper=time.sleep, clock=time.monotonic):
        self.delay, self.retries, self.timeout, self.max_bytes = delay, retries, timeout, max_bytes
        self.opener = opener or urllib.request.build_opener(Redirects())
        self.sleep, self.clock, self.last = sleeper, clock, {}
        self.deferred = {}
        self.events = []
    def get(self, address):
        address = encoded_uri(address)
        request_ok(address)
        host = url.urlsplit(address).hostname
        if self.deferred.get(host, 0) > self.clock():
            raise FetchError("rate-limit-deferred", "Host still in Retry-After cooldown.", retry_after=int(self.deferred[host] - self.clock()) + 1)
        for attempt in range(self.retries + 1):
            wait = self.delay - (self.clock() - self.last.get(host, -1e10))
            if wait > 0: self.sleep(wait)
            self.last[host] = self.clock()
            event = {"attempt": attempt + 1, "started_at_utc": now(), "url": address}
            try:
                req = urllib.request.Request(address, headers={"User-Agent": "ChurchTimesArchiveRecovery/1.0 (read-only historical preservation)", "Accept-Encoding": "identity"}, method="GET")
                with self.opener.open(req, timeout=self.timeout) as r:
                    request_ok(r.geturl())
                    declared = r.headers.get("Content-Length")
                    if declared and declared.isdigit() and int(declared) > self.max_bytes:
                        raise FetchError("too-large", "Response exceeds the configured byte cap.", r.status)
                    data = r.read(self.max_bytes + 1)
                    if len(data) > self.max_bytes: raise FetchError("too-large", "Response exceeds the configured byte cap.", r.status)
                    if declared and declared.isdigit() and len(data) != int(declared): raise FetchError("truncated", "Response length differs from Content-Length.", r.status)
                    headers = {k.lower(): v for k, v in r.headers.items() if k.lower() in {"content-type", "content-length", "content-encoding", "x-archive-orig-content-type", "last-modified", "etag", "memento-datetime", "x-wp-total", "x-wp-totalpages"}}
                    event.update({"origin_http_status": r.status, "bytes_received": len(data), "final_url": r.geturl()})
                    self.events.append(event)
                    return Response(r.geturl(), r.status, headers, data)
            except FetchError as e:
                event.update(e.metadata()); self.events.append(event); raise
            except urllib.error.HTTPError as e:
                seconds = retry_seconds(e.headers.get("Retry-After"))
                failure = FetchError("rate-limited" if e.code == 429 else "http-error", f"Public origin returned HTTP {e.code}.", e.code, retry_after=seconds)
                transient = e.code == 429 or 500 <= e.code <= 599
                if seconds is not None and seconds > 0:
                    self.deferred[host] = self.clock() + seconds
            except urllib.error.URLError as e:
                message = str(e.reason)
                tunnel = re.search(r"Tunnel connection failed: (\d+)", message)
                failure = FetchError("proxy-blocked" if tunnel else "network-error", message, tunnel_status=int(tunnel[1]) if tunnel else None)
                transient = not tunnel
                seconds = None
            except http.client.InvalidURL as e:
                failure, transient, seconds = FetchError("invalid-url", str(e)), False, None
            except (TimeoutError, OSError) as e:
                failure, transient, seconds = FetchError("network-error", str(e)), True, None
            event.update(failure.metadata()); self.events.append(event)
            if not transient or attempt == self.retries or (seconds is not None and seconds > 60): raise failure
            self.sleep(seconds if seconds is not None else min(2 ** attempt, 30))
        raise AssertionError("unreachable")

def cdx_url(domain, limit=1000, resume=None):
    query = {"url": domain + "/*", "output": "json", "fl": ",".join(FIELDS), "limit": limit, "showResumeKey": "true"}
    if resume: query["resumeKey"] = resume
    return "https://web.archive.org/cdx/search/cdx?" + url.urlencode(query)

def parse_cdx(data):
    text = data.decode("utf-8-sig").lstrip()
    value, end = json.JSONDecoder().raw_decode(text)
    if not isinstance(value, list): raise ValueError("CDX must return a JSON array.")
    tail = text[end:].strip()
    if tail.startswith("resumeKey:"): tail = tail[len("resumeKey:"):].strip()
    if tail and ("\n" in tail or len(tail) > 4096): raise ValueError("Malformed CDX resume key.")
    if not value: return [], tail or None
    header = value[0]
    if not isinstance(header, list) or not all(isinstance(h, str) for h in header) or not {"timestamp", "original", "statuscode", "mimetype"}.issubset(header): raise ValueError("Missing CDX fields.")
    rows = []
    for raw in value[1:]:
        if not isinstance(raw, list) or len(raw) != len(header): raise ValueError("Malformed CDX row.")
        row = dict(zip(header, raw))
        if not re.fullmatch(r"\d{14}", str(row["timestamp"])) or not original_ok(row["original"]): raise ValueError("Invalid capture timestamp/domain.")
        dt.datetime.strptime(str(row["timestamp"]), "%Y%m%d%H%M%S")
        rows.append(row)
    return rows, tail or None

REPLAY = re.compile(r"^https?://web\.archive\.org/web/(\d{1,14})(?:[a-z]+_)?/(https?://.+)$")
def unwrap(value):
    match = REPLAY.match(value)
    return match.group(2) if match else value

def replay_url(original, timestamp):
    if not original_ok(original) or not re.fullmatch(r"\d{14}", timestamp): raise ValueError("Invalid replay request.")
    return "https://web.archive.org/web/" + timestamp + "id_/" + encoded_uri(original)

def wayback_error(data):
    text = data[:40000].decode("utf-8", "replace").lower()
    return any(marker in text for marker in ("the wayback machine has not archived that url", "this url has been excluded from the wayback machine", "cannot be crawled or displayed due to robots.txt", "wayback machine doesn't have that page archived", "rate limit reached", "blocked site error", "wayback machine cannot display this web page", "wayback machine is currently down"))

def media_mismatch(mime, data):
    signatures = {"image/jpeg": (b"\xff\xd8\xff",), "image/png": (b"\x89PNG\r\n\x1a\n",), "image/gif": (b"GIF87a", b"GIF89a"), "image/x-icon": (b"\x00\x00\x01\x00",)}
    if mime in signatures: return not data.startswith(signatures[mime])
    if mime == "image/webp": return not (data.startswith(b"RIFF") and data[8:12] == b"WEBP")
    if mime == "image/svg+xml": return b"<svg" not in data[:4000].lower()
    return False

def listing_url(value):
    p = url.urlsplit(value)
    dated_index = bool(re.fullmatch(r"/\d{4}(?:/\d{1,2}){0,2}/?", p.path))
    return dated_index or bool(re.match(r"^/(?:category/|tag/|author/|page/\d+(?:/|$))", p.path)) or (not p.path.strip("/") and not url.parse_qs(p.query).get("p"))

class ArticleParser(HTMLParser):
    def __init__(self, original):
        super().__init__(convert_charrefs=True)
        self.original, self.meta, self.assets, self.paragraphs = original, {}, set(), []
        self.stack, self.title_text, self.h1_text, self.ld = [], [], [], []
        self.script, self.script_text, self.paragraph, self.article_scopes = False, [], None, 0
        self.article_elements = 0
        self.annotations = []
        self.scope_text = []
    def handle_starttag(self, tag, attrs):
        a = {key: value or "" for key, value in attrs}
        scope = tag == "article" or any(c in a.get("class", "").split() for c in ("entry-content", "post-content", "article-content", "td-post-content", "entry", "Content"))
        if scope: self.article_scopes += 1
        if tag == "article": self.article_elements += 1
        self.stack.append((tag, scope))
        for cls, key in (("meta_author", "author_text"), ("author", "author_text"), ("meta_date", "date_text"), ("entry-date", "date_text"), ("entry-title", "headline_text"), ("title", "headline_text")):
            if cls in a.get("class", "").split() and (key != "headline_text" or tag in {"h1", "h2"}): self.annotations.append([tag, key, [], len(self.stack)])
        if tag == "meta": self.meta[a.get("property") or a.get("name") or ""] = a.get("content", "")
        if tag == "link" and "shortlink" in a.get("rel", "").split(): self.meta["shortlink"] = unwrap(url.urljoin(self.original, a.get("href", "")))
        if tag == "link" and "canonical" in a.get("rel", "").split(): self.meta["canonical"] = unwrap(url.urljoin(self.original, a.get("href", "")))
        if tag in {"img", "source", "video", "audio", "embed"}:
            for key in ("src", "poster"):
                if a.get(key): self.assets.add(encoded_uri(url.urldefrag(unwrap(url.urljoin(self.original, a[key])))[0]))
            for candidate in a.get("srcset", "").split(","):
                if candidate.strip(): self.assets.add(encoded_uri(url.urldefrag(unwrap(url.urljoin(self.original, candidate.strip().split()[0])))[0]))
        if tag == "a" and re.search(r"\.(pdf|mp3|mp4|wav|ogg)(?:[?#]|$)", a.get("href", ""), re.I): self.assets.add(encoded_uri(url.urldefrag(unwrap(url.urljoin(self.original, a["href"])))[0]))
        if tag == "script" and a.get("type") == "application/ld+json": self.script, self.script_text = True, []
        if tag in {"p", "div", "br", "li", "td", "blockquote"}: self.scope_text.append("\n")
        if tag == "p" and any(scope for _, scope in self.stack): self.paragraph = []
        if tag in {"meta", "img", "source", "link", "br", "input", "embed", "hr"}: self.stack.pop()
    def handle_endtag(self, tag):
        if tag in {"p", "div", "br", "li", "td", "blockquote"}: self.scope_text.append("\n")
        for item in list(self.annotations):
            if item[0] == tag and item[3] == len(self.stack):
                self.meta.setdefault(item[1], " ".join("".join(item[2]).split()))
                self.annotations.remove(item)
        if tag == "script" and self.script:
            try: self.ld.append(json.loads("".join(self.script_text)))
            except json.JSONDecodeError: pass
            self.script = False
        if tag == "p" and self.paragraph is not None:
            text = " ".join("".join(self.paragraph).split())
            if text: self.paragraphs.append(text)
            self.paragraph = None
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag: del self.stack[i:]; break
    def handle_data(self, text):
        if self.script: self.script_text.append(text); return
        tags = {t for t, _ in self.stack}
        if tags & {"script", "style", "nav", "footer"}: return
        for item in self.annotations: item[2].append(text)
        if any(scope for _, scope in self.stack): self.scope_text.append(text)
        if "title" in tags: self.title_text.append(text)
        if "h1" in tags: self.h1_text.append(text)
        if self.paragraph is not None: self.paragraph.append(text)
    def result(self):
        def articles(obj):
            if isinstance(obj, list):
                for value in obj: yield from articles(value)
            elif isinstance(obj, dict):
                types = obj.get("@type", [])
                if isinstance(types, str): types = [types]
                if isinstance(types, list) and any(t in ("Article", "NewsArticle", "BlogPosting") for t in types): yield obj
                yield from articles(obj.get("@graph", []))
        structured = next((a for item in self.ld for a in articles(item)), {})
        author = structured.get("author")
        if isinstance(author, dict): author = author.get("name")
        if isinstance(author, list): author = [v.get("name") if isinstance(v, dict) else v for v in author]
        body = structured.get("articleBody") or "\n\n".join(" ".join(part.split()) for part in "".join(self.scope_text).split("\n") if part.strip())
        if not isinstance(body, str): body = ""
        path = url.urlsplit(self.original)
        plausible_path = bool(path.path.strip("/") or url.parse_qs(path.query).get("p")) and not listing_url(self.original) and not re.match(r"^/(?:directory_|contact\.|feedback\.|advert_rates\.)", path.path)
        publication_date = structured.get("datePublished") or self.meta.get("article:published_time") or None
        if not publication_date and self.meta.get("date_text"):
            try: publication_date = dt.datetime.strptime(self.meta["date_text"], "%B %d, %Y").date().isoformat()
            except ValueError: pass
        wp_id = url.parse_qs(url.urlsplit(self.meta.get("shortlink") or self.original).query).get("p", [None])[0]
        return {"title": structured.get("headline") or self.meta.get("og:title") or self.meta.get("headline_text") or "".join(self.h1_text).strip() or "".join(self.title_text).strip(),
                "author": author or self.meta.get("author") or self.meta.get("author_text") or None,
                "source_author_text": self.meta.get("author_text"), "source_date_text": self.meta.get("date_text"),
                "wordpress_post_id": wp_id if wp_id and wp_id.isdigit() else None,
                "publication_date": publication_date,
                "canonical_url": self.meta.get("canonical") or None, "new_canonical_url": None,
                "article_body": body or None,
                "is_article_candidate": plausible_path and len(body.strip()) >= 30 and (bool(structured) or self.article_elements <= 1),
                "assets": [{"original_url": x, "in_scope": original_ok(x)} for x in sorted(self.assets)],
                "confidence": "partial", "reviewer_decision": None}

def extract_article(data, original):
    parser = ArticleParser(original); parser.feed(data.decode("utf-8", "replace")); return parser.result()

class Recovery:
    def __init__(self, root, transport=None, retry_failed=False):
        self.root = store_path(root); self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.transport = transport or Transport()
        self.attempted = set()
        self.retry_failed = retry_failed
        path = self.root / "manifest.json"
        if path.is_symlink(): raise ValueError("Manifest must not be a symlink.")
        self.state = json.loads(path.read_text()) if path.exists() else {"schema": SCHEMA, "started_at_utc": now(), "domains": {}, "captures": {}, "records": {}, "requests": [], "current": {}, "leads": LEADS}
        if self.state.get("schema") != SCHEMA: raise ValueError("Unsupported existing manifest; refusing to overwrite.")
    def save(self): atomic(self.root / "manifest.json", json_bytes(self.state))
    def path(self, relative):
        p = self.root / relative
        if Path(relative).is_absolute() or ".." in Path(relative).parts or p.is_symlink() or self.root not in p.resolve().parents: raise ValueError("Unsafe manifest file path.")
        return p
    def saved(self, relative, data):
        path = self.path(relative); atomic(path, data)
        return {"path": relative, "sha256": sha(data), "bytes": len(data)}
    def get(self, address, purpose):
        entry = {"requested_at_utc": now(), "purpose": purpose, "url": address}
        attempt_offset = len(getattr(self.transport, "events", []))
        try:
            # Persist long Retry-After cooldowns across resumptions, without lengthy sleeps.
            host = url.urlsplit(address).hostname
            for prior in reversed(self.state["requests"]):
                if url.urlsplit(prior["url"]).hostname != host: continue
                seconds = prior.get("retry_after_seconds")
                if seconds:
                    until = dt.datetime.fromisoformat(prior.get("completed_at_utc", prior["requested_at_utc"])) + dt.timedelta(seconds=seconds)
                    remaining = (until - dt.datetime.now(dt.timezone.utc)).total_seconds()
                    if remaining > 0: raise FetchError("rate-limit-deferred", "Persisted Retry-After cooldown remains active.", retry_after=int(remaining) + 1)
                break
            response = self.transport.get(address)
            entry.update({"final_url": response.final_url, "origin_http_status": response.status, "bytes_received": len(response.data)})
            return response
        except FetchError as error:
            entry.update(error.metadata()); raise
        except KeyboardInterrupt:
            entry.update({"kind": "interrupted", "message": "Request interrupted; no completed response recorded."}); raise
        finally:
            entry["completed_at_utc"] = now()
            entry["transport_attempts"] = getattr(self.transport, "events", [])[attempt_offset:]
            self.state["requests"].append(entry); self.save()
    def index(self, domain, max_pages=20, page_size=1000):
        state = self.state["domains"].setdefault(domain, {"complete": False, "pages": [], "resume_key": None})
        if state["complete"]: return
        for _ in range(max_pages):
            address = cdx_url(domain, page_size, state["resume_key"])
            try:
                response = self.get(address, "cdx-index")
                evidence = self.saved(f"indexes/{domain}/page-{len(state['pages']) + 1:05}-{sha(response.data)[:12]}.json.txt", response.data)
                rows, resume = parse_cdx(response.data)
                state["pages"].append(evidence)
                for row in rows:
                    key = sha((row["original"] + "\n" + row["timestamp"]).encode())
                    self.state["captures"][key] = row
                state["resume_key"], state["complete"] = resume, not bool(resume)
                state.pop("failure", None); self.save()
                if not resume: return
            except (FetchError, ValueError, UnicodeError) as e:
                state["failure"] = e.metadata() if isinstance(e, FetchError) else {"kind": "invalid-index", "message": str(e)}
                self.save(); return
    def valid_cached(self, record):
        try:
            path = self.path(record["file"]["path"])
            return path.is_file() and sha(path.read_bytes()) == record["file"]["sha256"]
        except (KeyError, ValueError, OSError): return False
    def fixed_failure(self, record):
        failure = record.get("failure", {}) if record else {}
        return bool(record and record.get("status") == "failed" and not self.retry_failed and (failure.get("origin_http_status") == 404 or failure.get("kind") in {"archive-error-body", "different-original"}))
    def capture(self, row, source="cdx"):
        key = sha((row["original"] + "\n" + row["timestamp"]).encode())
        previous = self.state["records"].get(key)
        if previous and (key in self.attempted or self.fixed_failure(previous)): return previous
        self.attempted.add(key)
        if previous and previous.get("status") == "saved" and self.valid_cached(previous): return previous
        record = {"original_url": row["original"], "original_domain": url.urlsplit(row["original"]).hostname,
                  "requested_timestamp": row["timestamp"], "discovery_source": source, "cdx": row if source == "cdx" else None, "availability": "unknown",
                  "citations": [lead for lead in LEADS if lead["original"] == row["original"]],
                  "confidence": "citation-only" if any(lead["original"] == row["original"] for lead in LEADS) else None, "reviewer_decision": None}
        try:
            response = self.get(replay_url(row["original"], row["timestamp"]), "archive-download")
            effective = REPLAY.match(response.final_url)
            if response.status != 200: raise FetchError("http-error", "Replay did not return HTTP 200.", response.status)
            if not effective or len(effective.group(1)) != 14 or not original_ok(effective.group(2)): raise FetchError("invalid-replay", "Replay URL did not identify an in-scope capture.")
            if encoded_uri(effective.group(2)) != encoded_uri(row["original"]): raise FetchError("different-original", "Replay redirected to a different original URL; review separately.")
            mime = response.headers.get("x-archive-orig-content-type") or response.headers.get("content-type", "application/octet-stream")
            mime = mime.split(";")[0].strip().lower()
            expected = str(row.get("mimetype", ""))
            if expected in {"", "unk", "warc/revisit"} and re.search(r"\.(jpg|jpeg|png|gif|webp|svg|ico)(?:[?#]|$)", row["original"], re.I): expected = "image/unknown"
            if not response.data or media_mismatch(mime, response.data) or wayback_error(response.data) or (expected.startswith(("image/", "audio/", "video/")) and mime.startswith("text/")) or (mime == "application/pdf" and not response.data.startswith(b"%PDF-")):
                record["quarantine"] = self.saved("quarantine/" + key + ".bin", response.data)
                raise FetchError("archive-error-body", "Error/MIME-mismatched content quarantined; not counted as recovered.", response.status)
            digest = sha(response.data); relative = "raw/" + digest + ".bin"
            target = self.path(relative)
            if target.exists() and sha(target.read_bytes()) != digest:
                self.saved("quarantine/corrupt-" + key + ".bin", target.read_bytes())
            file = self.saved(relative, response.data)
            record.update({"status": "saved", "captured_timestamp": effective.group(1), "capture_url": response.final_url,
                           "replay_original_url": effective.group(2), "replay_http_status": response.status, "mime": mime, "file": file, "retrieved_at_utc": now(), "confidence": "partial", "availability": "retrieved"})
            if mime in {"text/html", "application/xhtml+xml"}:
                article = extract_article(response.data, row["original"])
                record["extraction"] = self.saved("extracted/" + key + ".json", json_bytes(article))
                record["article_candidate"], record["asset_references"] = article["is_article_candidate"], article["assets"]
        except (FetchError, ValueError) as e:
            record.update({"status": "failed", "failure": e.metadata() if isinstance(e, FetchError) else {"kind": "invalid-capture", "message": str(e)}})
            if isinstance(e, FetchError) and e.status == 404:
                record["availability"], record["confidence"] = "replay-404", "missing"
        self.state["records"][key] = record; self.save(); return record
    def citations(self):
        for lead in LEADS:
            address = "https://archive.org/wayback/available?" + url.urlencode({"url": lead["original"], **({"timestamp": lead["timestamp"]} if lead.get("timestamp") else {})})
            try:
                response = self.get(address, "citation-availability")
                evidence = self.saved("citations/" + sha(lead["original"].encode()) + ".json", response.data)
                value = json.loads(response.data).get("archived_snapshots", {}).get("closest", {})
                if value.get("available") is True and str(value.get("status")) == "200" and re.fullmatch(r"\d{14}", str(value.get("timestamp", ""))):
                    match = REPLAY.match(str(value.get("url", "")))
                    if not match or match.group(2) != lead["original"]: raise ValueError("Availability result points to a different original URL.")
                    row = {"original": lead["original"], "timestamp": value["timestamp"], "source": "availability"}
                    self.state["captures"].setdefault(sha((row["original"] + "\n" + row["timestamp"]).encode()), row)
                lead_state = self.state.setdefault("citation_checks", {})
                lead_state[lead["original"]] = {"evidence": evidence, "available": value.get("available") is True}
            except (FetchError, ValueError) as e:
                self.state.setdefault("citation_checks", {})[lead["original"]] = {"failure": e.metadata() if isinstance(e, FetchError) else {"kind": "invalid-availability", "message": str(e)}}
            self.save()
        # Explicitly test the supplied fixed capture, even when CDX/availability fail.
        self.capture(LEADS[0], "citation")
        try:
            response = self.get(LEADS[0]["citation_url"], "independent-citation-check")
            evidence = self.saved("citations/wikipedia-bola-odeleke.html", response.data)
            self.state["independent_citation"] = {"evidence": evidence, "old_url_present": LEADS[0]["original"].encode() in response.data}
        except FetchError as e:
            self.state["independent_citation"] = {"failure": e.metadata()}
        self.save()
    def refresh_extractions(self):
        # Re-extract cached HTML using the current parser without downloading again.
        for key, cached in self.state["records"].items():
            if cached.get("status") == "saved" and cached.get("mime") in {"text/html", "application/xhtml+xml"} and self.valid_cached(cached):
                article = extract_article(self.path(cached["file"]["path"]).read_bytes(), cached["original_url"])
                cached["extraction"] = self.saved("extracted/" + key + ".json", json_bytes(article))
                cached["article_candidate"], cached["asset_references"] = article["is_article_candidate"], article["assets"]
                cached["citations"] = [lead for lead in LEADS if lead["original"] == cached["original_url"]]
                indexed = self.state["captures"].get(key)
                if indexed and "statuscode" in indexed: cached["cdx"] = indexed
        self.save()
    def download(self, max_captures=200, all_versions=False):
        self.state["download_limit_reached"] = False
        self.refresh_extractions()
        rows = list(self.state["captures"].values())
        rows = [r for r in rows if str(r.get("statuscode", "200")) in {"200", "-"}]
        def priority(row):
            p = url.urlsplit(row["original"])
            is_html = row.get("mimetype") == "text/html"
            listing = listing_url(row["original"])
            cited = row["original"] in {lead["original"] for lead in LEADS}
            return (0 if cited else 1 if is_html and not listing else 2 if str(row.get("mimetype", "")).startswith(("image/", "audio/", "video/")) else 3, row["original"], -int(row["timestamp"]))
        rows.sort(key=priority)
        successful, attempts = set(), 0
        for row in rows:
            if not all_versions and row["original"] in successful: continue
            key = sha((row["original"] + "\n" + row["timestamp"]).encode())
            previous = self.state["records"].get(key)
            cached = previous and ((previous.get("status") == "saved" and self.valid_cached(previous)) or self.fixed_failure(previous))
            if not cached:
                if attempts >= max_captures: self.state["download_limit_reached"] = True; break
                attempts += 1
            record = self.capture(row, row.get("source", "cdx"))
            if record["status"] == "saved": successful.add(row["original"])
        # Follow in-scope embedded assets at the actual page capture timestamp.
        # CDX downloads above take precedence; references outside historical hosts remain unfetched.
        seen_assets = {record["original_url"] for record in self.state["records"].values() if record.get("discovery_source") in {"cdx", "availability"} and record.get("failure", {}).get("kind") != "rate-limit-deferred"}
        for parent in sorted(list(self.state["records"].values()), key=lambda r: r.get("captured_timestamp", ""), reverse=True):
            if parent.get("status") != "saved" or not self.valid_cached(parent): continue
            for asset in parent.get("asset_references", []):
                if not asset["in_scope"] or asset["original_url"] in seen_assets: continue
                seen_assets.add(asset["original_url"])
                if any(r.get("status") == "saved" and r["original_url"] == asset["original_url"] and self.valid_cached(r) for r in self.state["records"].values()): continue
                if attempts >= max_captures:
                    self.state["download_limit_reached"] = True; break
                attempts += 1
                self.capture({"original": asset["original_url"], "timestamp": parent["captured_timestamp"]}, "embedded-reference")
        self.save()
    def current_inventory(self, max_pages=20):
        current = self.state["current"]
        current.setdefault("posts", {})
        if not current.get("rest_complete"):
            page = current.get("next_page", 1)
            for _ in range(max_pages):
                address = CURRENT + "/wp-json/wp/v2/posts?" + url.urlencode({"status": "publish", "context": "view", "per_page": 100, "page": page, "_fields": "id,link,slug,date_gmt,modified_gmt,status,title,author,featured_media"})
                try:
                    response = self.get(address, "current-public-post-inventory")
                    posts = json.loads(response.data)
                    if not isinstance(posts, list): raise ValueError("Public WP post list expected.")
                    if any(p.get("status") != "publish" for p in posts): raise ValueError("Non-published content rejected.")
                    current.setdefault("evidence", []).append(self.saved(f"current/posts-{page:05}.json", response.data))
                    for post in posts: current["posts"][str(post["id"])] = post
                    current["next_page"] = page + 1
                    total_pages = response.headers.get("x-wp-totalpages")
                    total_posts = response.headers.get("x-wp-total")
                    if total_posts and total_posts.isdigit(): current["reported_total_posts"] = int(total_posts)
                    if total_pages and total_pages.isdigit(): current["reported_total_pages"] = int(total_pages)
                    if len(posts) < 100 or (total_pages and total_pages.isdigit() and page >= int(total_pages)): current["rest_complete"] = True
                    current.pop("failure", None); self.save()
                    if current.get("rest_complete"): break
                    page += 1
                except (FetchError, ValueError, KeyError) as e:
                    current["failure"] = e.metadata() if isinstance(e, FetchError) else {"kind": "invalid-current-inventory", "message": str(e)}
                    self.save(); break
        pending = list(current.get("sitemap_pending", [CURRENT + "/wp-sitemap.xml", CURRENT + "/sitemap_index.xml"]))
        done = set(current.get("sitemap_done", [])); links = set(current.get("sitemap_urls", []))
        retry_later = []
        for _ in range(max_pages):
            if not pending: break
            address = pending.pop(0)
            if address in done: continue
            try:
                response = self.get(address, "current-public-sitemap")
                if b"<!DOCTYPE" in response.data.upper() or b"<!ENTITY" in response.data.upper(): raise ValueError("Sitemap DTD/entity declarations rejected.")
                xml = ET.fromstring(response.data)
                if xml.tag.rsplit("}", 1)[-1] not in {"sitemapindex", "urlset"}: raise ValueError("Expected sitemap XML.")
                current.setdefault("sitemap_evidence", []).append(self.saved("current/sitemap-" + sha(address.encode()) + ".xml", response.data))
                found = [x.text.strip() for x in xml.iter() if x.tag.rsplit("}", 1)[-1] == "loc" and x.text]
                for value in found:
                    if url.urlsplit(value).hostname not in {"churchtimesnigeria.net", "www.churchtimesnigeria.net"}: continue
                    if url.urlsplit(value).scheme == "http": value = "https:" + value[5:]
                    request_ok(value)
                    if xml.tag.endswith("sitemapindex"): pending.append(value)
                    else: links.add(value)
                done.add(address)
                current.get("sitemap_failures", {}).pop(address, None)
            except (FetchError, ET.ParseError, ValueError) as e:
                retry_later.append(address)
                current.setdefault("sitemap_failures", {})[address] = e.metadata() if isinstance(e, FetchError) else {"kind": "invalid-sitemap", "message": str(e)}
        current.update({"sitemap_pending": [x for x in dict.fromkeys(pending + retry_later) if x not in done], "sitemap_done": sorted(done), "sitemap_urls": sorted(links)})
        self.save()
    def report(self):
        self.refresh_extractions()
        records = list(self.state["records"].values()); saved = [r for r in records if r.get("status") == "saved" and self.valid_cached(r)]
        domains = {}
        for domain in DOMAINS:
            rows = [r for r in self.state["captures"].values() if url.urlsplit(r["original"]).hostname == domain and r.get("source") != "availability"]
            successes = [r for r in saved if r["original_domain"] == domain]
            domains[domain] = {"cdx_complete": self.state["domains"].get(domain, {}).get("complete", False), "observed_capture_rows": len(rows), "cdx_status_counts": dict(collections.Counter(r["statuscode"] for r in rows)), "observed_unique_urls": len({r["original"] for r in rows}),
                "saved_records": len(successes), "saved_html": sum(r["mime"] in {"text/html", "application/xhtml+xml"} for r in successes),
                "saved_media": sum(r["mime"].startswith(("image/", "audio/", "video/")) or r["mime"] == "application/pdf" for r in successes),
                "partial_article_candidates": sum(r.get("article_candidate", False) for r in successes),
                "failed_capture_records": sum(r.get("status") == "failed" and r["original_domain"] == domain for r in records), "earliest_observed_capture": min((r["timestamp"] for r in rows), default=None), "latest_observed_capture": max((r["timestamp"] for r in rows), default=None)}
        blobs = {r["file"]["sha256"]: r["file"]["bytes"] for r in saved}
        html_records = [r for r in saved if r["mime"] in {"text/html", "application/xhtml+xml"}]
        assets = [r for r in saved if r not in html_records]
        groups = collections.defaultdict(list)
        for record in saved: groups[record["original_url"]].append(record)
        conflicts = [u for u, rs in groups.items() if len({r["file"]["sha256"] for r in rs}) > 1]
        return {"schema": SCHEMA, "generated_at_utc": now(), "domains": domains,
            "discovery_complete": all(x["cdx_complete"] for x in domains.values()), "observed_unique_urls": len({r["original"] for r in self.state["captures"].values() if r.get("source") != "availability"}),
            "unattempted_indexed_http200_urls": len({r["original"] for r in self.state["captures"].values() if str(r.get("statuscode", "200")) == "200"} - {r["original_url"] for r in records if r.get("failure", {}).get("kind") != "rate-limit-deferred"}),
            "indexed_http200_urls_not_saved": len({r["original"] for r in self.state["captures"].values() if str(r.get("statuscode", "200")) == "200"} - {r["original_url"] for r in saved}),
            "saved_capture_records": len(saved), "unique_raw_files": len(blobs), "raw_bytes": sum(blobs.values()), "raw_html_saves": len(html_records), "downloaded_asset_records": len(assets),
            "downloaded_media_records": sum(r["mime"].startswith(("image/", "audio/", "video/")) or r["mime"] == "application/pdf" for r in assets),
            "saved_mime_counts": dict(collections.Counter(r["mime"] for r in saved)),
            "unique_partial_article_files": len({r["file"]["sha256"] for r in html_records if r.get("article_candidate", False)}),
            "verified_full_articles": sum(r.get("confidence") == "verified-full" for r in saved), "partial_article_candidates": sum(r.get("article_candidate", False) for r in html_records),
            "citation_leads": len(LEADS), "unrecovered_citation_leads": sum(not any(r["original_url"] == lead["original"] for r in saved) for lead in LEADS),
            "failed_capture_attempts": sum(r.get("status") == "failed" for r in records), "confirmed_replay_404s": sum(r.get("failure", {}).get("origin_http_status") == 404 for r in records),
            "unrecovered_embedded_asset_urls": len({a["original_url"] for parent in saved for a in parent.get("asset_references", []) if a["in_scope"] and not any(s["original_url"] == a["original_url"] for s in saved)}),
            "external_asset_urls_not_fetched": len({a["original_url"] for parent in saved for a in parent.get("asset_references", []) if not a["in_scope"]}),
            "quarantined_records": sum("quarantine" in r for r in records), "conflicting_url_versions": conflicts,
            "failure_counts": dict(collections.Counter(r.get("kind", "http-response") for r in self.state["requests"] if "kind" in r)),
            "current_published_posts_observed": len(self.state["current"].get("posts", {})), "current_inventory_complete": self.state["current"].get("rest_complete", False),
            "current_reported_total_posts": self.state["current"].get("reported_total_posts"),
            "current_sitemap_urls_observed": len(self.state["current"].get("sitemap_urls", [])), "download_limit_reached": self.state.get("download_limit_reached", False)}
    def checksums(self):
        files = []
        for folder in ("raw", "indexes", "extracted", "citations", "current", "quarantine", "evidence"):
            directory = self.root / folder
            if directory.exists():
                for path in sorted(directory.rglob("*")):
                    if path.is_file():
                        relative = path.relative_to(self.root).as_posix(); data = self.path(relative).read_bytes()
                        files.append({"path": relative, "bytes": len(data), "sha256": sha(data)})
        for name in ("manifest.json", "coverage.json"):
            p = self.path(name)
            if p.exists(): files.append({"path": name, "bytes": p.stat().st_size, "sha256": sha(p.read_bytes())})
        atomic(self.root / "checksums.json", json_bytes(files)); return files
    def verify(self):
        problems = []
        for entry in json.loads(self.path("checksums.json").read_text()):
            try:
                if sha(self.path(entry["path"]).read_bytes()) != entry["sha256"]: problems.append(entry["path"])
            except (OSError, ValueError): problems.append(entry["path"])
        expected = [page for domain in self.state["domains"].values() for page in domain.get("pages", [])]
        expected += self.state["current"].get("evidence", []) + self.state["current"].get("sitemap_evidence", [])
        expected += [check["evidence"] for check in self.state.get("citation_checks", {}).values() if "evidence" in check]
        if "evidence" in self.state.get("independent_citation", {}): expected.append(self.state["independent_citation"]["evidence"])
        expected += [record[field] for record in self.state["records"].values() for field in ("extraction", "quarantine") if field in record]
        for entry in expected:
            if not self.valid_cached({"file": entry}): problems.append(entry["path"])
        for record in self.state["records"].values():
            if record.get("status") == "saved":
                if not self.valid_cached(record): problems.append(record["file"]["path"])
                elif media_mismatch(record.get("mime"), self.path(record["file"]["path"]).read_bytes()): problems.append(record["file"]["path"] + ": MIME signature")
        return sorted(set(problems))
    def package(self):
        files = self.checksums()
        if self.verify(): raise ValueError("Refusing to package corrupt recovered files.")
        target = self.path("private-evidence.tar.gz")
        with tarfile.open(target, "w:gz") as archive:
            for entry in files: archive.add(self.path(entry["path"]), arcname=entry["path"], recursive=False)
            archive.add(self.root / "checksums.json", arcname="checksums.json", recursive=False)
        os.chmod(target, 0o600)
        atomic(self.root / "private-evidence.tar.gz.sha256", (sha(target.read_bytes()) + "  private-evidence.tar.gz\n").encode())
        return target

def planned_requests(page_size=1000):
    return [cdx_url(d, page_size) for d in DOMAINS] + ["https://archive.org/wayback/available?" + url.urlencode({"url": lead["original"], **({"timestamp": lead["timestamp"]} if lead.get("timestamp") else {})}) for lead in LEADS] + [LEADS[0]["citation_url"], replay_url(LEADS[0]["original"], LEADS[0]["timestamp"]), CURRENT + "/wp-json/wp/v2/posts?status=publish&context=view&per_page=100", CURRENT + "/wp-sitemap.xml", CURRENT + "/sitemap_index.xml"]

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("collect", "download", "report", "verify", "package"))
    parser.add_argument("--store", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--delay", type=float, default=2)
    parser.add_argument("--max-pages", type=int, default=20)
    parser.add_argument("--page-size", type=int, default=1000)
    parser.add_argument("--max-captures", type=int, default=200)
    parser.add_argument("--all-versions", action="store_true")
    parser.add_argument("--retry-failed", action="store_true", help="Recheck previously observed replay 404s, error bodies and redirects.")
    args = parser.parse_args(argv)
    root = store_path(args.store)
    if args.delay < 1 or args.max_pages < 1 or not 1 <= args.page_size <= 1000 or args.max_captures < 1: parser.error("Use delay >= 1s and positive bounded page/capture limits.")
    if args.dry_run:
        print(json.dumps({"dry_run": True, "network_requests": 0, "writes": 0, "store": str(root), "planned_initial_gets": planned_requests(args.page_size)}, indent=2)); return 0
    recovery = Recovery(root, Transport(delay=args.delay), retry_failed=args.retry_failed)
    if args.command == "collect":
        for domain in DOMAINS: recovery.index(domain, args.max_pages, args.page_size)
        try:
            recovery.citations(); recovery.download(args.max_captures, args.all_versions); recovery.current_inventory(args.max_pages)
        except KeyboardInterrupt:
            atomic(root / "coverage.json", json_bytes(recovery.report())); recovery.checksums()
            print("Interrupted; checkpoint and evidence retained. Resume with the same --store.")
            return 130
    if args.command == "download":
        try: recovery.download(args.max_captures, args.all_versions)
        except KeyboardInterrupt:
            atomic(root / "coverage.json", json_bytes(recovery.report())); recovery.checksums()
            print("Interrupted; checkpoint and evidence retained. Resume with the same --store.")
            return 130
    if args.command == "verify":
        problems = recovery.verify(); print(json.dumps({"checksum_failures": problems})); return 1 if problems else 0
    if args.command == "package": print(recovery.package()); return 0
    report = recovery.report(); atomic(root / "coverage.json", json_bytes(report)); recovery.checksums()
    print(json.dumps(report, indent=2)); return 0 if report["discovery_complete"] else 2

if __name__ == "__main__": raise SystemExit(main())
