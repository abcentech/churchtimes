/**
 * Staff password policy, enforced server-side on user create, update (password change) and
 * password reset. Cheap, dependency-free rules aligned with NIST SP 800-63B: length matters most,
 * no composition rules, block known-bad passwords.
 */

export const PASSWORD_MIN_LENGTH = 12
export const PASSWORD_MAX_LENGTH = 128

/** Small list of very common passwords (compared after lowercasing and stripping non-alphanumerics). */
const COMMON = new Set(
  [
    'password',
    'password1',
    'password12',
    'password123',
    'password1234',
    'password12345',
    'password123456',
    'passw0rd1234',
    'p@ssw0rd1234',
    'letmein123456',
    'welcome12345',
    'welcome123456',
    'admin123456',
    'administrator',
    'adminadmin123',
    'iloveyou1234',
    'qwertyuiop12',
    'qwertyuiop123',
    'qwerty123456',
    'qwertyuiopasdfgh',
    'asdfghjkl123',
    'zxcvbnm12345',
    '123456789012',
    '1234567890123',
    '12345678901234',
    '111111111111',
    '000000000000',
    'abcdefghijkl',
    'abc123456789',
    'changeme1234',
    'changemenow',
    'trustno1trustno1',
    'monkey123456',
    'football1234',
    'baseball1234',
    'dragon123456',
    'sunshine1234',
    'princess1234',
    'lagos1234567',
    'nigeria12345',
    'nigeria123456',
    'abuja1234567',
    'jesuschrist12',
    'jesus1234567',
    'godisgood1234',
    'godisgood123',
    'hallelujah123',
    'churchtimes',
    'churchtimes1',
    'churchtimes12',
    'churchtimes123',
    'churchtimes1234',
    'churchtimesnigeria',
    'churchtimesnigeria1',
    'churchtimesnigeria123',
    'newsroom1234',
    'newsroom12345',
    'newsroom123456',
  ].map((s) => s.toLowerCase().replace(/[^a-z0-9]/g, '')),
)

const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')

export type PasswordContext = { email?: unknown; name?: unknown }

/**
 * Returns an error message, or `null` when the password is acceptable.
 */
export function checkPasswordPolicy(password: unknown, context: PasswordContext = {}): string | null {
  if (typeof password !== 'string') return 'Password is required.'
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`
  }
  if (password.trim() !== password) return 'Password must not start or end with a space.'
  if (new Set(password).size < 5) return 'Password is too repetitive.'

  const lower = password.toLowerCase()
  const norm = normalise(password)
  if (COMMON.has(norm)) return 'This password is too common. Choose a less guessable one.'

  const email = typeof context.email === 'string' ? context.email.trim().toLowerCase() : ''
  if (email) {
    const local = email.split('@')[0] ?? ''
    if (lower === email || (local.length >= 4 && norm === normalise(local))) {
      return 'Password must not be the same as your email address.'
    }
  }
  const name = typeof context.name === 'string' ? normalise(context.name) : ''
  if (name.length >= 4 && norm === name) return 'Password must not be the same as your name.'

  return null
}
