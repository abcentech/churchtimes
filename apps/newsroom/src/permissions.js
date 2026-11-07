/**
 * Role/permission helpers for UI convenience ONLY (which buttons to show). The CMS enforces every rule
 * server-side (docs/api-contracts.md §2); a button we show may still answer 403, and that is surfaced to the user.
 * The user object always comes from the server (GET /api/users/me); roles use the CMS spelling (hyphens).
 */

export const STAFF_ROLES = ['admin', 'editor-in-chief', 'section-editor', 'trusted-publisher', 'reporter'];
const EDITOR_ROLES = ['admin', 'editor-in-chief', 'section-editor'];

export function normRole(role) {
  return String(role || '').toLowerCase().replace(/_/g, '-');
}

function sectionIds(user) {
  if (user?.sections === 'all') return 'all';
  return (Array.isArray(user?.sections) ? user.sections : [])
    .map(s => String(s && typeof s === 'object' ? s.id : s));
}

function inSections(user, categoryId) {
  const ids = sectionIds(user);
  if (ids === 'all') return true;
  if (categoryId === undefined || categoryId === null || categoryId === '') return false;
  return ids.includes(String(categoryId));
}

/** "Editors in scope": admin, editor-in-chief, or section-editor whose sections include the category. */
export function isEditorInScope(user, categoryId) {
  const role = normRole(user?.role);
  if (role === 'admin' || role === 'editor-in-chief') return true;
  return role === 'section-editor' && inSections(user, categoryId);
}

export function isEditorRole(user) {
  return EDITOR_ROLES.includes(normRole(user?.role));
}

/**
 * @param {object|null} user server user object
 * @param {string} action
 * @param {{status?: string, categoryId?: any, isAuthor?: boolean}} ctx
 */
export function can(user, action, ctx = {}) {
  if (!user) return false;
  const role = normRole(user.role);
  if (!STAFF_ROLES.includes(role)) return false;
  const { status = 'draft', categoryId, isAuthor = false } = ctx;
  const editor = isEditorInScope(user, categoryId);

  switch (action) {
    case 'story.create':
    case 'media.upload':
    case 'live.post':
      return true;
    case 'story.edit':
      if (editor) return true;
      if (role === 'reporter') return isAuthor && (status === 'draft' || status === 'changes_requested');
      if (role === 'trusted-publisher') {
        return isAuthor && (['draft', 'changes_requested'].includes(status) || inSections(user, categoryId));
      }
      return false;
    case 'story.submit_review':
      return (editor || isAuthor) && (status === 'draft' || status === 'changes_requested');
    case 'story.request_changes':
    case 'story.approve':
      return editor && status === 'in_review';
    case 'story.publish':
      if (!['draft', 'in_review', 'approved', 'scheduled', 'archived'].includes(status)) return false;
      if (editor) return true;
      return role === 'trusted-publisher' && isAuthor && inSections(user, categoryId) && status !== 'archived';
    case 'story.schedule':
      // Same rule as publishing (the CMS uses one rule for ->published and ->scheduled), minus archived stories.
      // A scheduled story can be rescheduled by whoever may schedule it.
      if (!['draft', 'in_review', 'approved', 'scheduled'].includes(status)) return false;
      if (editor) return true;
      return role === 'trusted-publisher' && isAuthor && inSections(user, categoryId);
    case 'story.archive':
      return editor && status === 'published';
    case 'story.delete':
      return role === 'admin' || role === 'editor-in-chief';
    case 'submission.review':
    case 'submission.convert':
      return isEditorRole(user);
    case 'live.manage':
      return isEditorRole(user) || role === 'trusted-publisher';
    case 'live.approve':
      return editor || (role === 'trusted-publisher' && inSections(user, categoryId));
    case 'archive.view':
      // Recovered archive drafts are staff-only and the CMS only lists them for editors (reporters see their own work only).
      return isEditorRole(user);
    case 'archive.review':
      // Setting provenance.reviewStatus: admin, editor-in-chief, or a section-editor for the story's section.
      return editor;
    case 'audit.read':
      return role === 'admin' || role === 'editor-in-chief';
    default:
      return false;
  }
}
