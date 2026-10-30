import type { GlobalConfig } from 'payload'

import { isEditorInChief, isEditorRole, type UserLike } from '../access/roles'
import { isValidEmail } from '../lib/sanitize'
import { plainTextValidator } from '../lib/newsroomFields'

const asUser = (u: unknown): UserLike | null => (u ? (u as UserLike) : null)

/** Hard ceiling on `dailySendCap` whatever an editor types (free SMTP tiers are a few hundred a day). */
export const NEWSLETTER_DAILY_CAP_MAX = 10_000

/**
 * Newsletter sending (Agent E's digest builder and sender read it server-side). Off by default. Read: editor roles;
 * write: admin and editor-in-chief. SMTP credentials stay in the environment, never here.
 */
export const NewsletterSettings: GlobalConfig = {
  slug: 'newsletter-settings',
  label: 'Newsletter settings',
  admin: { group: 'Newsletter' },
  access: {
    read: ({ req }) => isEditorRole(asUser(req.user)),
    update: ({ req }) => isEditorInChief(asUser(req.user)),
  },
  fields: [
    { name: 'enabled', type: 'checkbox', defaultValue: false, admin: { description: 'Master switch for sending. Off: nothing is sent (dry runs still write drafts).' } },
    { name: 'dailyDigestEnabled', type: 'checkbox', defaultValue: false },
    { name: 'sendHourLagos', type: 'number', defaultValue: 6, min: 0, max: 23, validate: (v: unknown) => (v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23) ? true : 'Hour must be a whole number from 0 to 23 (Lagos time).') },
    {
      name: 'dailySendCap',
      type: 'number',
      required: true,
      defaultValue: 100,
      min: 0,
      max: NEWSLETTER_DAILY_CAP_MAX,
      validate: (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= NEWSLETTER_DAILY_CAP_MAX ? true : `Daily cap must be a whole number from 0 to ${NEWSLETTER_DAILY_CAP_MAX}.`),
      admin: { description: 'Hard stop: no more than this many e-mails in one Lagos day, whatever else is configured.' },
    },
    { name: 'fromName', type: 'text', maxLength: 80, validate: plainTextValidator('From name', 80) },
    { name: 'replyTo', type: 'text', maxLength: 254, validate: (v: unknown) => (v === null || v === undefined || v === '' || isValidEmail(v) ? true : 'Reply-to must be an e-mail address.') },
    { name: 'maxStoriesPerDigest', type: 'number', defaultValue: 6, min: 1, max: 20, validate: (v: unknown) => (v === null || v === undefined || (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 20) ? true : 'Stories per digest must be from 1 to 20.') },
    { name: 'includeDevotional', type: 'checkbox', defaultValue: false },
  ],
}
