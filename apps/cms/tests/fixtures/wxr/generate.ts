/**
 * Synthetic WXR 1.2 generator for tests. Every name, address and domain is invented (example.test). Never put a real
 * export, name, email or domain here.
 */

export type FixtureComment = {
  id: number
  parent?: number
  author?: string
  email?: string
  url?: string
  ip?: string
  content?: string
  dateGmt?: string
  approved?: string
  type?: string
}

export type FixtureItem = {
  id: number
  title?: string
  slug?: string
  status?: string
  postType?: string
  link?: string
  dateGmt?: string
  date?: string
  modifiedGmt?: string
  creator?: string
  content?: string
  excerpt?: string
  password?: string
  parent?: number
  categories?: { nicename: string; name: string }[]
  tags?: { nicename: string; name: string }[]
  meta?: Record<string, string>
  attachmentUrl?: string
  comments?: FixtureComment[]
}

export const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function itemXml(i: FixtureItem): string {
  const postType = i.postType ?? 'post'
  const status = i.status ?? 'publish'
  const slug = i.slug ?? `story-${i.id}`
  const date = i.dateGmt ?? '2023-05-04 10:30:00'
  const cats = (i.categories ?? [])
    .map((c) => `<category domain="category" nicename="${c.nicename}">${cdata(c.name)}</category>`)
    .join('')
  const tags = (i.tags ?? [])
    .map((c) => `<category domain="post_tag" nicename="${c.nicename}">${cdata(c.name)}</category>`)
    .join('')
  const meta = Object.entries(i.meta ?? {})
    .map(([k, v]) => `<wp:postmeta><wp:meta_key>${cdata(k)}</wp:meta_key><wp:meta_value>${cdata(v)}</wp:meta_value></wp:postmeta>`)
    .join('')
  const comments = (i.comments ?? [])
    .map(
      (c) => `<wp:comment>
<wp:comment_id>${c.id}</wp:comment_id>
<wp:comment_author>${cdata(c.author ?? 'Commenter One')}</wp:comment_author>
<wp:comment_author_email>${cdata(c.email ?? 'commenter@example.test')}</wp:comment_author_email>
<wp:comment_author_url>${cdata(c.url ?? 'https://commenter.example.test/')}</wp:comment_author_url>
<wp:comment_author_IP>${cdata(c.ip ?? '203.0.113.7')}</wp:comment_author_IP>
<wp:comment_date>2023-05-05 12:00:00</wp:comment_date>
<wp:comment_date_gmt>${c.dateGmt ?? '2023-05-05 11:00:00'}</wp:comment_date_gmt>
<wp:comment_content>${cdata(c.content ?? 'A synthetic comment.')}</wp:comment_content>
<wp:comment_approved>${cdata(c.approved ?? '1')}</wp:comment_approved>
<wp:comment_type>${cdata(c.type ?? '')}</wp:comment_type>
<wp:comment_parent>${c.parent ?? 0}</wp:comment_parent>
<wp:commentmeta><wp:meta_key>${cdata('secret_note')}</wp:meta_key><wp:meta_value>${cdata('private@example.test')}</wp:meta_value></wp:commentmeta>
</wp:comment>`,
    )
    .join('\n')
  return `<item>
<title>${cdata(i.title ?? `Synthetic story ${i.id}`)}</title>
<link>${esc(i.link ?? `https://old.example.test/${slug}/`)}</link>
<pubDate>Thu, 04 May 2023 10:30:00 +0000</pubDate>
<dc:creator>${cdata(i.creator ?? 'editor_one')}</dc:creator>
<guid isPermaLink="false">https://old.example.test/?p=${i.id}</guid>
<description></description>
<content:encoded>${cdata(i.content ?? '<p>Synthetic body.</p>')}</content:encoded>
<excerpt:encoded>${cdata(i.excerpt ?? '')}</excerpt:encoded>
<wp:post_id>${i.id}</wp:post_id>
<wp:post_date>${cdata(i.date ?? '2023-05-04 11:30:00')}</wp:post_date>
<wp:post_date_gmt>${cdata(date)}</wp:post_date_gmt>
<wp:post_modified_gmt>${cdata(i.modifiedGmt ?? '2023-05-06 08:00:00')}</wp:post_modified_gmt>
<wp:comment_status>${cdata('open')}</wp:comment_status>
<wp:post_name>${cdata(slug)}</wp:post_name>
<wp:status>${cdata(status)}</wp:status>
<wp:post_parent>${i.parent ?? 0}</wp:post_parent>
<wp:post_type>${cdata(postType)}</wp:post_type>
<wp:post_password>${cdata(i.password ?? '')}</wp:post_password>
${i.attachmentUrl ? `<wp:attachment_url>${cdata(i.attachmentUrl)}</wp:attachment_url>` : ''}
${cats}${tags}
${meta}
${comments}
</item>`
}

export function wxr(
  items: FixtureItem[],
  opts: {
    bom?: boolean
    prolog?: string
    raw?: string
    channelCategories?: { id: number; nicename: string; name: string }[]
    authors?: { id: number; login: string; display: string }[]
  } = {},
): string {
  const cats = (opts.channelCategories ?? [{ id: 3, nicename: 'news', name: 'News' }])
    .map(
      (c) =>
        `<wp:category><wp:term_id>${c.id}</wp:term_id><wp:category_nicename>${cdata(c.nicename)}</wp:category_nicename><wp:category_parent>${cdata('')}</wp:category_parent><wp:cat_name>${cdata(c.name)}</wp:cat_name></wp:category>`,
    )
    .join('\n')
  const authors = (opts.authors ?? [{ id: 2, login: 'editor_one', display: 'Editor One' }])
    .map(
      (a) =>
        `<wp:author><wp:author_id>${a.id}</wp:author_id><wp:author_login>${cdata(a.login)}</wp:author_login><wp:author_email>${cdata('editor@example.test')}</wp:author_email><wp:author_display_name>${cdata(a.display)}</wp:author_display_name><wp:author_first_name>${cdata('Ed')}</wp:author_first_name></wp:author>`,
    )
    .join('\n')
  return `${opts.bom ? '﻿' : ''}<?xml version="1.0" encoding="UTF-8" ?>
${opts.prolog ?? ''}<rss version="2.0" xmlns:excerpt="http://wordpress.org/export/1.2/excerpt/" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:wp="http://wordpress.org/export/1.2/">
<channel>
<title>Synthetic Site</title>
<link>https://old.example.test</link>
<wp:wxr_version>1.2</wp:wxr_version>
<wp:base_site_url>https://old.example.test</wp:base_site_url>
<wp:base_blog_url>https://old.example.test</wp:base_blog_url>
${authors}
${cats}
${items.map(itemXml).join('\n')}
${opts.raw ?? ''}
</channel>
</rss>
`
}

/** An async iterable that splits a string into small byte chunks (to exercise chunk boundaries and multi-byte chars). */
export async function* chunked(text: string, size = 7): AsyncGenerator<Uint8Array> {
  const bytes = Buffer.from(text, 'utf8')
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}

export const BILLION_LAUGHS = `<?xml version="1.0"?>
<!DOCTYPE lolz [
<!ENTITY lol "lol">
<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
]>
<rss version="2.0"><channel><item><title>&lol3;</title></item></channel></rss>`
