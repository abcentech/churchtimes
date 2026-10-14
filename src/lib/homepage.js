// Allocate stories once across the homepage; section/search routes remain complete.
export function selectHomepage(stories, { leadId = 29259, filter = 'All', limit = 6 } = {}) {
  const ids = new Set(), slugs = new Set();
  const unique = stories.filter(story => {
    if (ids.has(story.id) || slugs.has(story.slug)) return false;
    ids.add(story.id); slugs.add(story.slug); return true;
  });
  const lead = unique.find(story => story.id === leadId) || unique[0];
  const featured = unique.filter(story => story !== lead && story.category === 'News').slice(0, 3);
  const reserved = new Set([lead, ...featured]);
  const perspectivePool = unique.filter(story => !reserved.has(story) &&
    story.categories.some(category => ['Opinion', 'Columnists', "Publisher's Note"].includes(category)));
  // A deliberate category selection takes precedence over the supplemental section.
  const pinned = filter === 'All' ? perspectivePool.slice(0, 3) : [];
  const latest = unique.filter(story => !reserved.has(story) && !pinned.includes(story) &&
    (filter === 'All' || (filter === 'Opinion' ?
      story.categories.some(category => ['Opinion', 'Columnists'].includes(category)) : story.categories.includes(filter))));
  const shown = latest.slice(0, limit);
  const perspectives = perspectivePool.filter(story => !shown.includes(story)).slice(0, 3);
  return { lead, featured, latest, shown, perspectives };
}

export function uniqueHomeReports(articles, selection) {
  const seen = new Set([selection.lead, ...selection.featured, ...selection.shown,
    ...selection.perspectives].filter(Boolean).map(story => story.slug));
  return articles.filter(article => {
    if (seen.has(article.slug)) return false;
    seen.add(article.slug); return true;
  });
}
