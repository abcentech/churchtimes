/** Shared helpers. escapeHtml is the ONLY escaping helper: use it for every innerHTML interpolation. */

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 160);
}

export function formatTimeAgo(iso) {
  if (!iso) return 'recently';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff)) return 'recently';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function formatDate(iso) {
  if (!iso) return 'Today';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return 'Recently';
  }
}

const ROLE_LABELS = {
  reporter: 'Reporter',
  'section-editor': 'Section Editor',
  'editor-in-chief': 'Editor-in-Chief',
  admin: 'Administrator',
  'trusted-publisher': 'Trusted Publisher'
};
export function formatRoleName(role) {
  const clean = String(role || '').replace(/_/g, '-');
  return ROLE_LABELS[clean] || clean || 'Staff';
}

const STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In Review',
  changes_requested: 'Changes Requested',
  approved: 'Approved',
  scheduled: 'Scheduled',
  published: 'Published',
  archived: 'Archived'
};
export function formatStatusLabel(status) {
  return STATUS_LABELS[status] || String(status || '');
}

/** CSS-class-safe token for badge-* classes. */
export function cssToken(value) {
  return String(value || '').replace(/[^a-z0-9_-]/gi, '');
}

export function statusBadge(status) {
  return `<span class="badge badge-${cssToken(status)}">${escapeHtml(formatStatusLabel(status))}</span>`;
}

/** Categories are loaded from the CMS; this resolves an id to a display title. */
export function categoryTitleFrom(categories, id) {
  const found = (categories || []).find(c => String(c.id) === String(id));
  return found ? found.title : '';
}

/**
 * Race guard for async renders: call the returned function to start a render; the token it returns says whether
 * that render is still the latest one (stale responses must not overwrite newer content).
 */
export function latestGuard() {
  let n = 0;
  return () => {
    const id = ++n;
    return () => id === n;
  };
}
