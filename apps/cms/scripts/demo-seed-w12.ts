/**
 * Waves 1-2 demo content for `npm run demo` (called by scripts/demo-seed.ts; never run against a real database).
 * EVERYTHING is invented: author profiles, topics, key points, a pull quote, a photo gallery, a sponsored story, an analysis
 * with an "Updated" stamp and a correction, the published site-trust pages and (disabled) giving settings.
 * Idempotent: does nothing when the demo author profiles already exist.
 */
import type { Payload } from 'payload'
import sharp from 'sharp'

import { textToLexical } from '../src/endpoints/convertSubmission'

type Row = Record<string, unknown> & { id: number }
type Say = (m: string) => void

const lex = (text: string) => textToLexical(text) as { root: { children: unknown[] } }
const block = (id: string, fields: Record<string, unknown>) => ({ type: 'block', version: 2, format: '', fields: { id, blockName: '', ...fields } })

export async function seedWaves12(payload: Payload, opts: { admin: Row; categories: Map<string, number>; say: Say }): Promise<void> {
  const { categories: cat, say } = opts
  const already = await payload.count({ collection: 'authors', where: { slug: { equals: 'demo-ada-okafor' } }, overrideAccess: true })
  if (already.totalDocs > 0) {
    say('waves 1-2 demo content already present')
    return
  }
  const admin = { ...opts.admin, collection: 'users' } as never

  // Images large enough to get the AVIF sizes (card 800 w, hero 1600 w) and a blur placeholder.
  const image = async (name: string, alt: string, width: number, height: number, rgb: [number, number, number], caption = '') => {
    const data = await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).jpeg({ quality: 80 }).toBuffer()
    return (await payload.create({
      collection: 'media',
      data: { alt, caption, credit: 'Demo image' } as never,
      file: { data, mimetype: 'image/jpeg', name, size: data.length },
      user: admin,
      overrideAccess: true,
    })) as unknown as Row
  }
  const adaPhoto = await image('demo-author-ada.jpg', 'Ada Okafor, demo correspondent', 600, 600, [150, 110, 90])
  const tundePhoto = await image('demo-author-tunde.jpg', 'Tunde Bello, demo editor', 600, 600, [90, 110, 150])
  const hero = await image('demo-w12-hero.jpg', 'Demo: worshippers outside a rebuilt church', 1800, 1000, [60, 90, 70], 'Demo picture: a rebuilt church.')
  const gallery = [
    await image('demo-gallery-1.jpg', 'Demo: choir in white robes', 1700, 1100, [200, 190, 160], 'The choir sings at the rededication.'),
    await image('demo-gallery-2.jpg', 'Demo: congregation with raised hands', 1700, 1100, [120, 140, 170], 'The congregation during the service.'),
    await image('demo-gallery-3.jpg', 'Demo: new roof of the church building', 1700, 1100, [170, 120, 100], 'The new roof, finished in October.'),
  ]

  // ---- Author profiles and topics -------------------------------------------------------------------------------------
  const author = async (data: Record<string, unknown>) => (await payload.create({ collection: 'authors', data: data as never, overrideAccess: true })) as unknown as Row
  const ada = await author({
    name: 'Ada Okafor', slug: 'demo-ada-okafor', role: 'Senior Correspondent, Abuja (demo)', isPublic: true, photo: adaPhoto.id,
    bio: 'Ada covers religious freedom and church life in northern Nigeria. This is an invented demo profile.',
    socials: [{ kind: 'x', url: 'https://x.com/example' }, { kind: 'website', url: 'https://example.org/ada' }],
  })
  const tunde = await author({
    name: 'Tunde Bello', slug: 'demo-tunde-bello', role: 'Features Editor (demo)', isPublic: true, photo: tundePhoto.id,
    bio: 'Tunde edits features and explainers. This is an invented demo profile.',
  })
  await author({ name: 'Hidden Profile', slug: 'demo-hidden-profile', role: 'Not public (demo)', isPublic: false })

  const topic = async (data: Record<string, unknown>) => (await payload.create({ collection: 'topics', data: data as never, overrideAccess: true })) as unknown as Row
  const persecution = await topic({ name: 'Religious freedom', slug: 'religious-freedom', kind: 'topic', isPublic: true, description: 'Reporting on attacks, displacement and the right to worship (demo).' })
  const anglican = await topic({ name: 'Anglican Communion', slug: 'anglican-communion', kind: 'denomination', isPublic: true, description: 'News from the Church of Nigeria and the wider Communion (demo).' })
  const lent = await topic({ name: 'Rebuilding Together', slug: 'rebuilding-together', kind: 'series', isPublic: true, description: 'A demo series on churches rebuilt after violence.' })
  const youth = await topic({ name: 'Youth ministry', slug: 'youth-ministry', kind: 'ministry', isPublic: true, description: 'Young people in church life (demo).' })
  await topic({ name: 'Internal planning', slug: 'internal-planning', kind: 'topic', isPublic: false, description: 'Not public: never shown to readers (demo).' })
  say('waves 1-2: 3 author profiles (2 public) and 5 topics (4 public) created')

  // ---- Stories -----------------------------------------------------------------------------------------------------------
  const make = async (data: Record<string, unknown>) =>
    (await payload.create({ collection: 'articles', data: data as never, user: admin, overrideAccess: true, context: { seed: true } })) as unknown as Row
  const hour = 3_600_000
  const published = new Date(Date.now() - 6 * hour).toISOString()

  const analysis = lex(
    'Three years after the attack, the parish of St Andrew has reopened its doors. Members say the rebuilding was slow but shared.\n\n' +
      'The diocese raised most of the money locally, with help from partner churches abroad.\n\n' +
      'Worshippers filled the new building on Sunday for a service of rededication.',
  )
  analysis.root.children.splice(2, 0, block('demow12pullquote01', { blockType: 'pullQuote', quote: 'We did not rebuild a building. We rebuilt a family.', attribution: 'The Rev. Grace Adeyemi, vicar (demo)' }))
  analysis.root.children.push(
    block('demow12gallery0001', {
      blockType: 'gallery',
      images: [
        { id: 'demow12galrow00001', image: gallery[0].id, caption: 'The choir at the rededication service.' },
        { id: 'demow12galrow00002', image: gallery[1].id },
        { id: 'demow12galrow00003', image: gallery[2].id },
      ],
    }),
  )
  await make({
    title: 'Demo analysis: how a northern parish rebuilt after the attack',
    slug: 'demo-w12-parish-rebuilt',
    excerpt: 'A demo story with every waves 1-2 feature: kicker, key points, pull quote, gallery, topics, author profile, update stamp and a correction.',
    kicker: 'Rebuilding Together',
    contentType: 'analysis',
    keyPoints: [
      { text: 'The church reopened three years after it was burned (demo).' },
      { text: 'Most of the money was raised by members and the diocese.' },
      { text: 'Partner churches abroad paid for the new roof.' },
    ],
    category: cat.get('special-report') ?? cat.get('news'),
    topics: [persecution.id, anglican.id, lent.id],
    bylineAuthor: ada.id,
    bylineName: 'Ada Okafor',
    featuredImage: hero.id,
    content: analysis,
    status: 'published',
    publishedAt: published,
    lastSubstantiveUpdate: new Date(Date.now() - 2 * hour).toISOString(),
    corrections: [{ note: 'An earlier version gave the wrong year for the attack. It was 2023, not 2022.', correctedAt: new Date(Date.now() - 2 * hour).toISOString() }],
  })

  await make({
    title: 'Demo sponsored: a Christian bookshop opens in Enugu',
    slug: 'demo-w12-sponsored-bookshop',
    excerpt: 'Paid partner content, shown with the "Sponsored" label. Invented for the demo.',
    kicker: 'Partner content',
    contentType: 'sponsored',
    category: cat.get('advertorial') ?? cat.get('news'),
    bylineName: 'Demo Partner',
    content: lex('This is invented sponsored content. Readers must always see the Sponsored label on it.'),
    status: 'published',
    publishedAt: new Date(Date.now() - 5 * hour).toISOString(),
  })

  await make({
    title: 'Demo explainer: what the synod decides, and how',
    slug: 'demo-w12-synod-explainer',
    excerpt: 'An explainer with key points and an author profile (demo).',
    contentType: 'explainer',
    keyPoints: [{ text: 'The synod is the church parliament (demo).' }, { text: 'Bishops, clergy and lay members vote in houses.' }],
    category: cat.get('features') ?? cat.get('news'),
    topics: [anglican.id],
    bylineAuthor: tunde.id,
    content: lex('A synod brings together bishops, clergy and lay members. Each house votes on motions. This is invented demo text.'),
    status: 'published',
    publishedAt: new Date(Date.now() - 4 * hour).toISOString(),
  })

  await make({
    title: 'Demo opinion: young people are not leaving the church, they are changing it',
    slug: 'demo-w12-youth-opinion',
    excerpt: 'An opinion piece with a pull quote (demo).',
    contentType: 'opinion',
    category: cat.get('opinion') ?? cat.get('news'),
    topics: [youth.id],
    bylineAuthor: tunde.id,
    content: (() => {
      const doc = lex('Every Sunday I meet young people who want more from church, not less. This is invented demo text.')
      doc.root.children.push(block('demow12pullquote02', { blockType: 'pullQuote', quote: 'They want to serve, not just to sit.', attribution: 'Tunde Bello' }))
      return doc
    })(),
    status: 'published',
    publishedAt: new Date(Date.now() - 3 * hour).toISOString(),
  })

  await make({
    title: 'Demo fact-check: no, the synod did not ban drums',
    slug: 'demo-w12-factcheck-drums',
    excerpt: 'A fact-check label demo.',
    contentType: 'factcheck',
    kicker: 'Fact-check',
    keyPoints: [{ text: 'A viral message claimed drums were banned (demo).' }, { text: 'The synod minutes contain no such decision.' }],
    category: cat.get('news'),
    topics: [anglican.id],
    bylineAuthor: ada.id,
    content: lex('A message shared widely claimed that drums were banned in services. We checked the minutes. This is invented demo text.'),
    status: 'published',
    publishedAt: new Date(Date.now() - 2 * hour).toISOString(),
  })

  // A draft by the hidden profile: never on a public page.
  await make({ title: 'Demo draft with hidden topic', slug: 'demo-w12-hidden-draft', category: cat.get('news'), content: lex('Draft text (demo).'), status: 'draft' })

  // Tag some imported archive stories so topic and author pages have more than a handful of cards.
  const pool = (payload.db as unknown as { pool: { query: (t: string, v?: unknown[]) => Promise<unknown> } }).pool
  await pool.query(
    `INSERT INTO articles_rels ("order", parent_id, path, topics_id)
     SELECT 1, a.id, 'topics', ($1::int[])[1 + (a.id % 4)]
       FROM articles a WHERE a.status = 'published' AND a.slug NOT LIKE 'demo-w12-%' AND a.id % 7 = 0`,
    [[persecution.id, anglican.id, lent.id, youth.id]],
  )
  await pool.query(`UPDATE articles SET byline_author_id = $1 WHERE status = 'published' AND slug NOT LIKE 'demo-w12-%' AND id % 11 = 0`, [ada.id])
  await pool.query(`UPDATE articles SET byline_author_id = $1 WHERE status = 'published' AND slug NOT LIKE 'demo-w12-%' AND id % 13 = 0 AND byline_author_id IS NULL`, [tunde.id])
  say('waves 1-2: 5 published demo stories (analysis, sponsored, explainer, opinion, fact-check) and archive stories tagged')

  // ---- Globals -----------------------------------------------------------------------------------------------------------
  await payload.updateGlobal({
    slug: 'site-trust',
    data: {
      published: true,
      editorialStandards: lex(
        'Church Times Nigeria (demo) reports accurately, fairly and independently. We verify facts before we publish, name our sources wherever we can, and separate news from opinion.\n\n' +
          'Paid content is always labelled Sponsored. Advertisers and donors never decide what we report.',
      ),
      ownershipFunding: lex('This demo publication is funded by readers, advertising and donations. Invented text for the demo; the owner replaces it before launch.'),
      ethicsCorrectionsPolicy: lex(
        'When we get something wrong we correct it quickly and say so at the end of the story, with the date of the correction.\n\n' +
          'To report an error, write to the editors using the contact details below.',
      ),
      contactEditors: 'The Editor (demo)\neditors@example.org\nLagos, Nigeria',
    } as never,
    overrideAccess: true,
  })
  await payload.updateGlobal({
    slug: 'giving-settings',
    data: {
      enabled: false,
      provider: 'paystack',
      currencies: [
        { currency: 'NGN', presets: [200_000, 500_000, 1_000_000], minimum: 100_000, maximum: 100_000_000, label: 'Naira' },
        { currency: 'USD', presets: [1_000, 2_500, 5_000], minimum: 500, maximum: 500_000, label: 'US dollars' },
        { currency: 'GBP', presets: [1_000, 2_500, 5_000], minimum: 500, maximum: 500_000, label: 'Pounds sterling' },
      ],
      causes: [
        { key: 'general', label: 'Where it is needed most', enabled: true },
        { key: 'relief', label: 'Relief reporting', enabled: true },
      ],
      thankYouNote: 'Thank you for supporting independent Christian journalism (demo).',
      bankTransferNote: 'Bank transfer and USSD are offered on the secure payment page (demo).',
    } as never,
    overrideAccess: true,
  })
  say('waves 1-2: site trust pages published; giving settings filled in (still disabled)')
}
