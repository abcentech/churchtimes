import type { CollectionConfig } from 'payload'

import { editorInChiefOnly } from '../access/roles'
import { auditDeleteHook } from '../lib/audit'
import { clampLimit } from '../lib/clampLimit'
import { SLUG_MAX, TOPIC_DESCRIPTION_MAX, TOPIC_KINDS, TOPIC_NAME_MAX, plainTextValidator, slugValidator } from '../lib/newsroomFields'
import { editorsWrite, publicProfileRead, slugFromName } from './Authors'

const KIND_LABELS: Record<(typeof TOPIC_KINDS)[number], string> = {
  topic: 'Topic',
  denomination: 'Denomination',
  series: 'Series',
  ministry: 'Ministry',
}

/** Tags readers can follow (topic pages /topic/<slug>/). Categories stay the sections; topics cut across them. */
export const Topics: CollectionConfig = {
  slug: 'topics',
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'slug', 'kind', 'isPublic'], group: 'Newsroom' },
  // What an article carries for `topics` at depth >= 1.
  defaultPopulate: { name: true, slug: true, kind: true, isPublic: true },
  access: {
    read: publicProfileRead,
    create: editorsWrite,
    update: editorsWrite,
    delete: editorInChiefOnly,
  },
  hooks: {
    beforeOperation: [clampLimit],
    beforeValidate: [slugFromName('name')],
    afterDelete: [auditDeleteHook('topics', (d) => (d.slug ? `slug ${d.slug}` : undefined))],
  },
  fields: [
    { name: 'name', type: 'text', required: true, maxLength: TOPIC_NAME_MAX, validate: plainTextValidator('Name', TOPIC_NAME_MAX, { required: true }) },
    {
      name: 'slug',
      type: 'text',
      required: true,
      unique: true,
      index: true,
      maxLength: SLUG_MAX,
      validate: slugValidator,
      admin: { position: 'sidebar', description: 'Address of the topic page (/topic/<slug>/). Generated from the name when empty.' },
    },
    {
      name: 'kind',
      type: 'select',
      required: true,
      defaultValue: 'topic',
      options: TOPIC_KINDS.map((k) => ({ label: KIND_LABELS[k], value: k })),
      admin: { position: 'sidebar' },
    },
    {
      name: 'description',
      type: 'textarea',
      maxLength: TOPIC_DESCRIPTION_MAX,
      validate: plainTextValidator('Description', TOPIC_DESCRIPTION_MAX, { multiline: true }),
    },
    {
      name: 'isPublic',
      type: 'checkbox',
      defaultValue: false,
      index: true,
      admin: { position: 'sidebar', description: 'Show this topic on articles and give it a public topic page.' },
    },
  ],
}
