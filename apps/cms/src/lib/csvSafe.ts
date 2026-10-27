/**
 * CSV cells for the files the importer, the link audit and the categorisation eval write for humans to open in a
 * spreadsheet. Text taken from an export (a category slug, a title, a path) can start with `=`, `+`, `-`, `@`, a tab or a
 * carriage return, which Excel, Sheets and LibreOffice run as a formula. Such a cell gets a leading single quote (shown as
 * plain text, the OWASP "CSV injection" mitigation); cells with a comma, quote or line break are RFC 4180 quoted.
 * Numbers and booleans are written as they are (a negative number is not a formula).
 */
const FORMULA_START = /^[=+\-@\t\r]/

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  let text = String(value)
  if (FORMULA_START.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export const csvRow = (cells: readonly unknown[]): string => cells.map(csvCell).join(',')
