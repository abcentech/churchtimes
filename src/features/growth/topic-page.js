// Browser view of /topic/{slug}/ and /topic/ (also reachable as #topic/{slug}). The public host server-renders the same
// content (tools/public-routes/topic-pages.mjs) and embeds the topic JSON, which is reused here instead of fetching again.
import { fetchTaxonomy, fetchTopicIndex, validTaxonomySlug } from './taxonomy-api.js';
import { bindFollowButtons, followButtonHTML } from './follow.js';
import { cmsErrorMessage } from '../../lib/published-articles.js';

export const KIND_LABELS = { topic: 'Topic', denomination: 'Denomination', series: 'Series', ministry: 'Ministry' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function embeddedTopic(slug) {
  const node = document.querySelector('#public-topic');
  if (!node) return null;
  node.remove();
  try { const topic = JSON.parse(node.textContent || 'null'); return topic?.slug === slug && Array.isArray(topic.articles) ? topic : null; } catch { return null; }
}
function state(target, title, description, retry) {
  target.innerHTML = `<div class="container section-list newsroom-state"><h1>${escape(title)}</h1><p role="status">${escape(description)}</p>${retry ? '<button class="outline-button" type="button">Try again</button>' : ''}<a class="text-link" href="#home">Explore the current edition</a></div>`;
  if (retry) target.querySelector('button').addEventListener('click', retry);
  setMeta(title, description);
}
function setMeta(title, description) {
  document.title = `${title} — Church Times Nigeria`;
  const set = (selector, value) => { const el = document.querySelector(selector); if (el) el.content = value; };
  set('meta[name="description"]', description);
  set('meta[property="og:title"]', title);
  set('meta[property="og:description"]', description);
}

export async function mountTopicPage(api, slug) {
  const target = document.querySelector('#growth-page');
  if (!target) return false;
  const signal = api.signal;
  const topicHref = s => `${api.publicBase}topic/${s}/`;
  if (!api.cmsUrl) {
    target.setAttribute('aria-busy', 'false');
    state(target, 'Topics are not available yet.', 'Read the current edition while the newsroom topics are prepared.');
    return false;
  }
  try {
    if (!slug) {
      const topics = await fetchTopicIndex({ baseUrl: api.cmsUrl, signal });
      if (!target.isConnected) return false;
      target.innerHTML = `${api.intro('BROWSE', 'Topics.', 'Reporting grouped by topic, denomination, series and ministry. Follow any of them to see new stories on the home page.')}<section class="container section-list growth-topic-index">${topics.length ? `<ul>${topics.map(t => `<li><a href="${escape(topicHref(t.slug))}">${escape(t.name)}</a> <small>${escape(KIND_LABELS[t.kind])}</small> ${followButtonHTML({ kind: 'topic', slug: t.slug, name: t.name }, escape)}</li>`).join('')}</ul>` : '<p>No topics have been published yet.</p>'}</section>`;
      bindFollowButtons(target);
      setMeta('Topics', 'Browse Church Times Nigeria reporting by topic, denomination, series and ministry.');
      return true;
    }
    if (!validTaxonomySlug(slug)) { state(target, 'Topic unavailable.', 'This topic is not available.'); return false; }
    const topic = embeddedTopic(slug) || await fetchTaxonomy({ kind: 'topic', slug, baseUrl: api.cmsUrl, signal });
    if (!target.isConnected) return false;
    if (!topic) { state(target, 'Topic unavailable.', 'This topic is not available.'); return false; }
    const description = topic.description || `Church Times Nigeria reporting on ${topic.name}.`;
    target.innerHTML = `${api.intro(escape(KIND_LABELS[topic.kind].toUpperCase()), escape(topic.name), escape(description))}<section class="container section-list"><div class="growth-topic-actions">${followButtonHTML({ kind: 'topic', slug: topic.slug, name: topic.name }, escape)}<a class="text-link" href="${escape(topicHref(''))}">All topics</a></div>${topic.articles.length ? `<div class="story-grid">${topic.articles.slice(0, 20).map(a => api.reportCard(a)).join('')}</div>` : '<p>No published reports in this topic yet.</p>'}</section>`;
    api.bindCMSImages?.(target);
    bindFollowButtons(target);
    setMeta(topic.name, description);
    return true;
  } catch (error) {
    if (!target.isConnected || error?.type === 'cancelled') return false;
    state(target, 'We couldn’t load this topic.', cmsErrorMessage(error) || 'Please try again later.', () => { target.setAttribute('aria-busy', 'true'); mountTopicPage(api, slug); });
    return false;
  } finally {
    if (target.isConnected) target.setAttribute('aria-busy', 'false');
  }
}
