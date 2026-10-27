import { createHash, randomInt } from 'node:crypto'

import { isHoneypotHit, stripHeaderValue, type FieldError } from './publicEndpoint'
import { cleanText, isValidEmail } from './sanitize'

/** Pure helpers for POST /api/public/contact (go-live contract C5). */

export const CONTACT_TOPICS = ['general', 'advertising', 'corrections', 'tips', 'other'] as const
export type ContactTopic = (typeof CONTACT_TOPICS)[number]

export const CONTACT_MAX_BODY_BYTES = 16 * 1024
export const CONTACT_TURNSTILE_ACTION = 'contact-message'

// Same alphabet as story submissions (no 0, O, 1, I, L), so the public form can validate it.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const CONTACT_REFERENCE_RE = /^MSG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/

export function generateContactReference(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)]
  return `MSG-${out}`
}

export type ValidContactMessage = { name: string; email: string; topic: ContactTopic; message: string }

export type ContactValidation =
  | { ok: true; honeypot: false; data: ValidContactMessage }
  | { ok: true; honeypot: true }
  | { ok: false; errors: FieldError[] }

/** Whitelist copy: unknown fields (status, reference, ipHash ...) are ignored. Email is lower-cased. */
export function validateContactInput(raw: unknown): ContactValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ message: 'Request body must be a JSON object.' }] }
  }
  const input = raw as Record<string, unknown>
  if (isHoneypotHit(input)) return { ok: true, honeypot: true }

  const errors: FieldError[] = []

  const name = cleanText(input.name)
  if (!name) errors.push({ field: 'name', message: 'Name is required.' })
  else if (name.length < 2) errors.push({ field: 'name', message: 'Name must be at least 2 characters.' })
  else if (name.length > 120) errors.push({ field: 'name', message: 'Name must be at most 120 characters.' })

  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (!email) errors.push({ field: 'email', message: 'Email is required.' })
  else if (!isValidEmail(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' })

  const topic = typeof input.topic === 'string' ? input.topic : ''
  if (!(CONTACT_TOPICS as readonly string[]).includes(topic)) {
    errors.push({ field: 'topic', message: `Topic must be one of: ${CONTACT_TOPICS.join(', ')}.` })
  }

  const message = cleanText(input.message, { multiline: true })
  if (!message) errors.push({ field: 'message', message: 'Message is required.' })
  else if (message.length < 20) errors.push({ field: 'message', message: 'Message must be at least 20 characters.' })
  else if (message.length > 5000) errors.push({ field: 'message', message: 'Message must be at most 5000 characters.' })

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    honeypot: false,
    data: { name, email: email.toLowerCase(), topic: topic as ContactTopic, message },
  }
}

const squash = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/** Duplicate fingerprint: same address and same message (whitespace and case insensitive). */
export function computeContactHash(input: { email: string; message: string }): string {
  return createHash('sha256')
    .update([input.email.trim().toLowerCase(), squash(input.message)].join('\u0000'))
    .digest('hex')
}

const MAX_RECIPIENTS = 10

/** CONTACT_NOTIFY_TO: comma list. Never returned to a client; invalid entries are reported for startup/log checks. */
export function parseRecipientList(raw: string | undefined): { valid: string[]; invalid: string[] } {
  const valid: string[] = []
  const invalid: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const entry = part.trim()
    if (!entry) continue
    if (isValidEmail(entry) && valid.length < MAX_RECIPIENTS) valid.push(entry)
    else invalid.push(entry.length > 40 ? `${entry.slice(0, 40)}...` : entry)
  }
  return { valid, invalid }
}

export type ContactNotification = { subject: string; text: string; replyTo: string }

/** Builds the staff notification. Header-bound values (subject, reply-to) have CR/LF removed. */
export function buildContactNotification(
  msg: ValidContactMessage & { reference: string },
): ContactNotification {
  return {
    subject: stripHeaderValue(`[Contact: ${msg.topic}] ${msg.name} (${msg.reference})`, 200),
    replyTo: stripHeaderValue(msg.email, 254),
    text: [
      `Reference: ${msg.reference}`,
      `Topic: ${msg.topic}`,
      `From: ${stripHeaderValue(msg.name, 120)} <${stripHeaderValue(msg.email, 254)}>`,
      '',
      msg.message,
      '',
      '-- Reply to this email to answer the sender. Triage it in the CMS under Contact messages.',
    ].join('\n'),
  }
}
