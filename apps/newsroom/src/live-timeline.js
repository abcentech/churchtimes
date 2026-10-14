import { sortPublishedNewestFirst } from './live-order.js';

/**
 * Data for the staff live console: the Published Timeline and the pending queue of one event.
 *
 * One query sorted by creation `sequence` and capped at 100 would drop an old update that is approved late (its
 * creation sequence is low, its publishSequence is the newest). So two queries are made: the approved updates
 * newest-published first (-publishSequence) and the pending ones newest-created first (-sequence), each capped
 * at LIVE_TIMELINE_LIMIT. Rejected updates are not needed by the console and are not fetched.
 */
export const LIVE_TIMELINE_LIMIT = 100;

/** The two CMS queries (query-string objects for GET /api/live-updates) for one event. */
export function liveTimelineQueries(eventId) {
  const base = { 'where[event][equals]': String(eventId), limit: String(LIVE_TIMELINE_LIMIT), depth: '1' };
  return {
    approved: { ...base, 'where[status][equals]': 'approved', sort: '-publishSequence' },
    pending: { ...base, 'where[status][equals]': 'pending', sort: '-sequence' }
  };
}

const bySequenceDesc = (a, b) => (Number(b.sequence) || 0) - (Number(a.sequence) || 0);

/**
 * Merge the two result sets (raw CMS docs): de-duplicated by id, approved first (sortPublishedNewestFirst, the same
 * order as live-order.js), then pending newest first. Status is re-checked so an unfiltered answer cannot put an
 * update in the wrong list.
 */
export function mergeLiveTimeline(approvedDocs, pendingDocs) {
  const seen = new Set();
  const take = (docs, status) => (docs || []).filter(d => {
    if (!d || d.status !== status || seen.has(String(d.id))) return false;
    seen.add(String(d.id));
    return true;
  });
  const approved = sortPublishedNewestFirst(take(approvedDocs, 'approved'));
  const pending = take(pendingDocs, 'pending').sort(bySequenceDesc);
  return [...approved, ...pending];
}

/** fetchDocs(queryObject) resolves to the array of raw CMS docs. Both queries run in parallel; either failing rejects. */
export async function loadLiveTimeline(fetchDocs, eventId) {
  const q = liveTimelineQueries(eventId);
  const [approved, pending] = await Promise.all([fetchDocs(q.approved), fetchDocs(q.pending)]);
  return mergeLiveTimeline(approved, pending);
}
