import { describe, expect, it } from 'vitest'

import { checkPasswordPolicy } from '../../src/lib/passwordPolicy'

describe('checkPasswordPolicy', () => {
  it('accepts a long, uncommon password', () => {
    expect(checkPasswordPolicy('correct horse battery staple')).toBeNull()
    expect(checkPasswordPolicy('Test-only-pass-1234!', { email: 'a@b.test' })).toBeNull()
  })

  it('rejects non-strings and short passwords (< 12)', () => {
    expect(checkPasswordPolicy(undefined)).toMatch(/required/)
    expect(checkPasswordPolicy('Short-1!')).toMatch(/at least 12/)
    expect(checkPasswordPolicy('a'.repeat(11))).toMatch(/at least 12/)
  })

  it('rejects over-long passwords and leading/trailing spaces', () => {
    expect(checkPasswordPolicy('x1'.repeat(70))).toMatch(/at most 128/)
    expect(checkPasswordPolicy(' correct horse battery')).toMatch(/space/)
  })

  it('rejects common passwords regardless of case and punctuation', () => {
    for (const p of ['password1234', 'PASSWORD1234', 'Pass-word-1234', '123456789012', 'qwertyuiop12', 'ChurchTimes123']) {
      expect(checkPasswordPolicy(p), p).toMatch(/too common|repetitive/)
    }
  })

  it('rejects repetitive passwords', () => {
    expect(checkPasswordPolicy('aaaaaaaaaaaaaaaa')).toMatch(/repetitive/)
    expect(checkPasswordPolicy('abababababababab')).toMatch(/repetitive/)
  })

  it('rejects the email address, or its local part, as the password', () => {
    expect(checkPasswordPolicy('editor.person@example.org', { email: 'Editor.Person@Example.org' })).toMatch(/email/)
    expect(checkPasswordPolicy('editor-person-1234', { email: 'editorperson1234@example.org' })).toMatch(/email/)
    expect(checkPasswordPolicy('editor.person@example.org', { email: 'someone.else@example.org' })).toBeNull()
  })

  it("rejects the user's name as the password", () => {
    expect(checkPasswordPolicy('Adaobi Okafor Nwosu', { name: 'adaobi okafor nwosu' })).toMatch(/name/)
  })
})
