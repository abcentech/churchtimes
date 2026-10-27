/**
 * Article URL template for the cross-app suite (owner decision D1: articles live at `/{slug}/`).
 * Mirrors PUBLIC_ARTICLE_PATH_TEMPLATE (apps/cms/src/lib/redirectPaths.ts): unset or empty is `/{slug}/`.
 *
 * The CMS and the public host (tools/serve-public.mjs `articlePathTemplate`, PR #44) both run with the REQUESTED template.
 */
export const ARTICLE_TEMPLATES = ['/{slug}/', '/reports/{slug}/'] as const
export type ArticleTemplate = (typeof ARTICLE_TEMPLATES)[number]
export const LEGACY_TEMPLATE: ArticleTemplate = '/reports/{slug}/'

export function requestedTemplate(env: NodeJS.ProcessEnv = process.env): ArticleTemplate {
  const v = (env.PUBLIC_ARTICLE_PATH_TEMPLATE ?? '').trim()
  if (v === '') return '/{slug}/'
  if ((ARTICLE_TEMPLATES as readonly string[]).includes(v)) return v as ArticleTemplate
  throw new Error(`PUBLIC_ARTICLE_PATH_TEMPLATE must be "/{slug}/" or "/reports/{slug}/" (got "${v.slice(0, 80)}").`)
}

export type ArticlePathConfig = {
  /** Template the CMS runs with (what the owner asked for). */
  articlePathTemplate: ArticleTemplate
  /** Template the public host serves: always equals articlePathTemplate. */
  publicArticlePathTemplate: ArticleTemplate
}

export function resolveArticlePathConfig(_repoRoot: string, env: NodeJS.ProcessEnv = process.env): ArticlePathConfig {
  const articlePathTemplate = requestedTemplate(env)
  return { articlePathTemplate, publicArticlePathTemplate: articlePathTemplate }
}

export const articlePath = (cfg: Pick<ArticlePathConfig, 'publicArticlePathTemplate'>, slug: string): string =>
  cfg.publicArticlePathTemplate.replace('{slug}', slug)

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Regex matching a URL that ends with the article path for `slug`. */
export const articlePathRegExp = (cfg: Pick<ArticlePathConfig, 'publicArticlePathTemplate'>, slug: string): RegExp =>
  new RegExp(`${escapeRe(articlePath(cfg, slug))}$`)
