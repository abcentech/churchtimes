import { describe, expect, it } from 'vitest'

import { redirectsCsv } from '../../src/import/linkAudit'
import { csvCell, csvRow } from '../../src/lib/csvSafe'

describe('csvCell (spreadsheet formula safety)', () => {
  it('prefixes a single quote to cells that start with = + - @ tab or CR', () => {
    for (const bad of ['=SUM(A1)', '+1', '-2+3', '@cmd', '\tx', '\rx', "=HYPERLINK(\"http://evil\")"]) {
      expect(csvCell(bad).replace(/^"/, '').startsWith("'"), bad).toBe(true)
    }
  })
  it('leaves normal text and numbers alone, quotes commas, quotes and line breaks', () => {
    expect(csvCell('local-news')).toBe('local-news')
    expect(csvCell(-3)).toBe('-3')
    expect(csvCell(0.5)).toBe('0.5')
    expect(csvCell(null)).toBe('')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvRow([1, '=1+1', 'ok'])).toBe("1,'=1+1,ok")
  })
  it('redirect rules keep their shape for ordinary paths', () => {
    expect(redirectsCsv([{ from: '/a/', to: '/b/', status: 301 }])).toBe('from,to,status\n/a/,/b/,301\n')
  })
})
