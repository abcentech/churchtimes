import { BlocksFeature, EXPERIMENTAL_TableFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import type { Block } from 'payload'

import { YOUTUBE_BLOCK_SLUG, YOUTUBE_TITLE_MAX, validateVideoId, validateYoutubeTitle } from '../lib/lexicalEmbeds'

/**
 * The one embed an article body may hold (go-live contract C1.1). It stores an 11-character video id and an
 * optional title, never a URL; the public site rebuilds a privacy-enhanced player URL from the id and loads it
 * only after the reader's consent. `validateEmbeds` (collections/Articles.ts) enforces the same rules on the API.
 */
export const youtubeEmbedBlock: Block = {
  slug: YOUTUBE_BLOCK_SLUG,
  labels: { singular: 'YouTube video', plural: 'YouTube videos' },
  fields: [
    {
      name: 'videoId',
      type: 'text',
      required: true,
      validate: (value: unknown) => validateVideoId(value),
      admin: { description: 'The 11-character id from the video address (the part after "v=" or youtu.be/).' },
    },
    {
      name: 'title',
      type: 'text',
      maxLength: YOUTUBE_TITLE_MAX,
      validate: (value: unknown) => validateYoutubeTitle(value),
      admin: { description: `Optional short title shown before the video loads, up to ${YOUTUBE_TITLE_MAX} characters.` },
    },
  ],
}

/**
 * Editor for `articles.content`: Payload's default features plus the YouTube block and tables (standard
 * `table` > `tablerow` > `tablecell` nodes, the shape the public renderer reads).
 */
export const articleContentEditor = lexicalEditor({
  features: ({ defaultFeatures }) => [
    ...defaultFeatures,
    BlocksFeature({ blocks: [youtubeEmbedBlock] }),
    EXPERIMENTAL_TableFeature(),
  ],
})
