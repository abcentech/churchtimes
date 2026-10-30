import type { ServerComponentProps } from 'payload'

/**
 * Admin list view of `donations` (above the table): CSV download links for reconciliation. The endpoint decides what is
 * in the file (personal columns for admins only) and refuses everyone but admin / editor-in-chief; this is only a shortcut.
 */
export function DonationsExportLink(props: Partial<ServerComponentProps>) {
  const role = (props.user as { role?: string } | undefined)?.role
  const personal = role === 'admin'
  const base = '/api/donations/export'
  return (
    <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'baseline', margin: '0 0 1rem' }}>
      <strong>Download CSV:</strong>
      <a href={`${base}?status=succeeded`}>succeeded gifts</a>
      <a href={base}>all rows</a>
      <span style={{ opacity: 0.8 }}>
        {personal
          ? 'Includes names, e-mail addresses and provider references (admin). Store the file securely and delete it after use.'
          : 'Without names or e-mail addresses (admins only see those). Amounts are in minor units and as major units.'}{' '}
        Filter by date with <code>?from=2026-10-01&amp;to=2026-10-31</code>.
      </span>
    </div>
  )
}
