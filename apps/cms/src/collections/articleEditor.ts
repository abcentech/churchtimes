import { BlocksFeature, EXPERIMENTAL_TableFeature, lexicalEditor } from '@payloadcms/richtext-lexical'
import type { Block } from 'payload'

import {
  AV_BLOCK_SLUG,
  AV_CAPTION_MAX,
  AV_MIME,
  AV_TITLE_MAX,
  AV_URL_MAX,
  avTextProblem,
  isSafeAvSourceUrl,
  isSafeAvUrl,
} from '../lib/avMedia'
import { YOUTUBE_BLOCK_SLUG, YOUTUBE_TITLE_MAX, validateVideoId, validateYoutubeTitle } from '../lib/lexicalEmbeds'
import {
  GALLERY_BLOCK_SLUG,
  GALLERY_CAPTION_MAX,
  GALLERY_IMAGES_MAX,
  PULL_QUOTE_ATTRIBUTION_MAX,
  PULL_QUOTE_BLOCK_SLUG,
  PULL_QUOTE_MAX,
  plainTextValidator,
} from '../lib/newsroomFields'

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
      validate: (value: unknown) => (value === undefined || value === null || value === '' || isSafeAvSourceUrl(value) ? true : 'Use an https address on the old site or this CMS, or a path starting with /wp-content/uploads/.'),
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
 * Pull quote (waves 1-2): a short plain-text quotation from the story and who said it. Rendered as an aside by the public
 * site (never as HTML). `validateEmbeds` (collections/Articles.ts) enforces the same rules on the API.
 */
export const pullQuoteBlock: Block = {
  slug: PULL_QUOTE_BLOCK_SLUG,
  labels: { singular: 'Pull quote', plural: 'Pull quotes' },
  fields: [
    {
      name: 'quote',
      type: 'textarea',
      required: true,
      maxLength: PULL_QUOTE_MAX,
      validate: plainTextValidator('The pull quote', PULL_QUOTE_MAX, { required: true }),
      admin: { description: `Plain text, up to ${PULL_QUOTE_MAX} characters. Quote exactly what was said in the story.` },
    },
    {
      name: 'attribution',
      type: 'text',
      maxLength: PULL_QUOTE_ATTRIBUTION_MAX,
      validate: plainTextValidator('The pull quote attribution', PULL_QUOTE_ATTRIBUTION_MAX),
      admin: { description: 'Who said it, for example "Archbishop Henry Ndukuba".' },
    },
  ],
}

/**
 * Photo gallery (waves 1-2): 1 to 12 images from the media library, each with its alt text (from the media) and an optional
 * caption for this story. Gallery images count as body images (`bodyMedia`), so they become public with the article and are
 * frozen while it is published, exactly like inline images.
 */
export const galleryBlock: Block = {
  slug: GALLERY_BLOCK_SLUG,
  labels: { singular: 'Photo gallery', plural: 'Photo galleries' },
  fields: [
    {
      name: 'images',
      type: 'array',
      required: true,
      minRows: 1,
      maxRows: GALLERY_IMAGES_MAX,
      labels: { singular: 'Image', plural: 'Images' },
      fields: [
        {
          name: 'image',
          type: 'upload',
          relationTo: 'media',
          required: true,
          filterOptions: { mimeType: { in: ['image/jpeg', 'image/png', 'image/webp'] } },
          admin: { description: 'The image must have alt text in the media library.' },
        },
        {
          name: 'caption',
          type: 'text',
          maxLength: GALLERY_CAPTION_MAX,
          validate: plainTextValidator('A gallery caption', GALLERY_CAPTION_MAX),
          admin: { description: 'Optional caption for this story; the media caption is used when empty.' },
        },
      ],
    },
  ],
}

/**
 * Editor for `articles.content`: Payload's default features plus the YouTube and audio/video blocks and tables (standard
 * `table` > `tablerow` > `tablecell` nodes, the shape the public renderer reads).
 */
export const articleContentEditor = lexicalEditor({
  features: ({ defaultFeatures }) => [
    ...defaultFeatures,
    BlocksFeature({ blocks: [youtubeEmbedBlock, audioVideoBlock, pullQuoteBlock, galleryBlock] }),
    EXPERIMENTAL_TableFeature(),
  ],
})
