/**
 * First path segments that real routes own. With the article path template `/{slug}/` (owner decision D1) an article
 * lives at the site root, so a slug equal to one of these would shadow, or be shadowed by, a real route.
 * Matching is case-insensitive on the whole slug. Keep this list in step with the public host's routes
 * (docs/api-contracts.md C7) and extend it whenever a new top-level route ships.
 */
export const RESERVED_ROOT_SLUGS: ReadonlySet<string> = new Set([
  // CMS / API / app surfaces
  "admin",
  "api",
  "graphql",
  "newsroom",
  "login",
  "logout",
  "account",
  "preview",
  "static",
  "assets",
  "media",
  "uploads",
  "health",
  "healthz",
  // public site sections and tools
  "newsletter",
  "contact",
  "search",
  "category",
  "categories",
  "tag",
  "tags",
  "author",
  "authors",
  "topic",
  "topics",
  "section",
  "sections",
  "reports",
  "report",
  "articles",
  "live",
  "events",
  "submit",
  "tips",
  "advertise",
  "advertising",
  "about",
  "privacy",
  "terms",
  "corrections",
  "subscribe",
  "unsubscribe",
  // feeds and crawler files
  "feed",
  "feeds",
  "rss",
  "sitemap",
  "sitemap.xml",
  "robots.txt",
  "ads.txt",
  "favicon.ico",
  "manifest.json",
  // WordPress
  "wp-content",
  "wp-admin",
  "wp-json",
  "wp-includes",
  "wp-login.php",
  "xmlrpc.php",
  "page",
  "comments",
  "attachment",
  "trackback",
  "embed",
  "amp",
]);

/** True when `slug` would collide with a real root route under `/{slug}/`. */
export const isReservedSlug = (slug: string): boolean =>
  RESERVED_ROOT_SLUGS.has(slug.toLowerCase());
