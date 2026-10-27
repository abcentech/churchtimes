/**
 * Article URL template for the cross-app suite (owner decision D1: articles live at `/{slug}/`).
 * Mirrors PUBLIC_ARTICLE_PATH_TEMPLATE (apps/cms/src/lib/redirectPaths.ts): unset or empty is `/{slug}/`.
 *
 * The CMS in the harness always runs with the REQUESTED template. The public host (tools/serve-public.mjs, Codex lane) is given
 * the same template only when it supports one. While it does not (PR #44 "configurable article paths" unmerged) the public-facing
 * assertions are pinned to the legacy `/reports/{slug}/` so the suite stays green; that is `articlePathPinned`.
 */
import fs from 'node:fs'
import path from 'node:path'

export const ARTICLE_TEMPLATES = ['/{slug}/', '/reports/{slug}/'] as const
export type ArticleTemplate = (typeof ARTICLE_TEMPLATES)[number]
export const LEGACY_TEMPLATE: ArticleTemplate = '/reports/{slug}/'

export function requestedTemplate(env: NodeJS.ProcessEnv = process.env): ArticleTemplate {
  const v = (env.PUBLIC_ARTICLE_PATH_TEMPLATE ?? '').trim()
  if (v === '') return '/{slug}/'
  if ((ARTICLE_TEMPLATES as readonly string[]).includes(v)) return v as ArticleTemplate
  throw new Error(`PUBLIC_ARTICLE_PATH_TEMPLATE must be "/{slug}/" or "/reports/{slug}/" (got "${v.slice(0, 80)}").`)
}

/** True when the public host source understands the template option. TODO(PR #44): becomes true once it merges. */
export function publicHostSupportsTemplate(repoRoot: string): boolean {
  try {
    return /articlePathTemplate|PUBLIC_ARTICLE_PATH_TEMPLATE/.test(fs.readFileSync(path.join(repoRoot, 'tools', 'serve-public.mjs'), 'utf8'))
  } catch {
    return false
  }
}

export type ArticlePathConfig = {
  /** Template the CMS runs with (what the owner asked for). */
  articlePathTemplate: ArticleTemplate
  /** Template the public host actually serves: equals articlePathTemplate unless pinned. */
  publicArticlePathTemplate: ArticleTemplate
  /** True when the public host lacks template support and the public assertions use the legacy template. */
  articlePathPinned: boolean
}

export function resolveArticlePathConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): ArticlePathConfig {
  const articlePathTemplate = requestedTemplate(env)
  const supported = publicHostSupportsTemplate(repoRoot)
  return {
    articlePathTemplate,
    publicArticlePathTemplate: supported ? articlePathTemplate : LEGACY_TEMPLATE,
    articlePathPinned: !supported && articlePathTemplate !== LEGACY_TEMPLATE,
  }
}

export const articlePath = (cfg: Pick<ArticlePathConfig, 'publicArticlePathTemplate'>, slug: string): string =>
  cfg.publicArticlePathTemplate.replace('{slug}', slug)

const escapeRe = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Regex matching a URL that ends with the article path for `slug`. */
export const articlePathRegExp = (cfg: Pick<ArticlePathConfig, 'publicArticlePathTemplate'>, slug: string): RegExp =>
  new RegExp(`${escapeRe(articlePath(cfg, slug))}$`)
