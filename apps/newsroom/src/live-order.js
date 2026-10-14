/**
 * Order of the staff "Published Timeline".
 *
 * The CMS stamps `publishSequence` when an update becomes approved and the PUBLIC feed is ordered by it
 * (ascending). The staff console shows the same timeline newest first, so it must sort by `publishSequence`
 * descending: an update created early but approved late belongs at the top, not wherever its creation
 * `sequence` happens to put it. Updates without a publishSequence (should not happen for approved rows) sink to the bottom.
 */
export function sortPublishedNewestFirst(updates) {
  const key = u => (Number.isFinite(u.publishSequence) ? u.publishSequence : -Infinity);
  return [...updates].sort((a, b) => {
    const d = key(b) - key(a);
    if (d !== 0 && !Number.isNaN(d)) return d;
    return (Number(b.sequence) || 0) - (Number(a.sequence) || 0);
  });
}
