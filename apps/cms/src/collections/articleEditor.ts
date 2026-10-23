import { BlocksFeature, EXPERIMENTAL_TableFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import type { Block } from 'payload'

import {
  AV_BLOCK_SLUG,
  AV_CAPTION_MAX,
  AV_MIME,
  AV_TITLE_MAX,
  AV_URL_MAX,
  avTextProblem,
  isSafeAvUrl,
} from '../lib/avMedia'
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
 * Self-hosted audio or video (API contract v1.19). Either `media` (a file in the Media collection: mp4, webm, mp3,
 * m4a or ogg) or, for an import whose file could not be found, the legacy `sourceUrl`. `title` is the accessible
 * name. `validateEmbeds` and `validateAvMedia` (collections/Articles.ts) enforce the same rules on the API.
 */
export const audioVideoBlock: Block = {
  slug: AV_BLOCK_SLUG,
  labels: { singular: 'Audio or video', plural: 'Audio and video' },
  fields: [
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'video',
      options: [
        { label: 'Video', value: 'video' },
        { label: 'Audio', value: 'audio' },
      ],
    },
    {
      name: 'media',
      type: 'upload',
      relationTo: 'media',
      filterOptions: { mimeType: { in: [...AV_MIME] } },
      admin: { description: 'The audio or video file (MP4, WebM, MP3, M4A or OGG) from the media library.' },
    },
    {
      name: 'sourceUrl',
      type: 'text',
      maxLength: AV_URL_MAX,
      validate: (value: unknown) => (value === undefined || value === null || value === '' || isSafeAvUrl(value) ? true : 'Use an http(s) address or a path starting with /.'),
      admin: { description: 'Only for content imported from the old site whose file was not found. Prefer uploading the file.' },
    },
    {
      name: 'poster',
      type: 'upload',
      relationTo: 'media',
      filterOptions: { mimeType: { in: ['image/jpeg', 'image/png', 'image/webp'] } },
      admin: { description: 'Optional picture shown before a video plays.' },
    },
    {
      name: 'title',
      type: 'text',
      required: true,
      maxLength: AV_TITLE_MAX,
      validate: (value: unknown) =>
        typeof value !== 'string' || value.trim() === '' ? 'A title is required (it is the accessible name).' : (avTextProblem(value, 'title', AV_TITLE_MAX) ?? true),
    },
    {
      name: 'caption',
      type: 'text',
      maxLength: AV_CAPTION_MAX,
      validate: (value: unknown) => avTextProblem(value, 'caption', AV_CAPTION_MAX) ?? true,
    },
    {
      name: 'transcriptUrl',
      type: 'text',
      maxLength: AV_URL_MAX,
      validate: (value: unknown) => (value === undefined || value === null || value === '' || isSafeAvUrl(value) ? true : 'Use an http(s) address or a path starting with /.'),
      admin: { description: 'Optional link to a transcript.' },
    },
    { name: 'duration', type: 'number', min: 0, max: 86400, admin: { description: 'Length in seconds, if known.' } },
  ],
}

/**
 * Editor for `articles.content`: Payload's default features plus the YouTube and audio/video blocks and tables (standard
 * `table` > `tablerow` > `tablecell` nodes, the shape the public renderer reads).
 */
export const articleContentEditor = lexicalEditor({
  features: ({ defaultFeatures }) => [
    ...defaultFeatures,
    BlocksFeature({ blocks: [youtubeEmbedBlock, audioVideoBlock] }),
    EXPERIMENTAL_TableFeature(),
  ],
})
