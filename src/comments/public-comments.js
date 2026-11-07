import { fetchPublicComments, publicCommentId, publicCommentsEndpoint } from '../lib/public-comments.js';
import './public-comments.css';

export const commentsConfig = (env = import.meta.env) => ({endpoint:publicCommentsEndpoint(env.VITE_PUBLIC_COMMENTS_URL)});
export function commentsMarkup(articleId, config = commentsConfig()) {
  const id = publicCommentId(articleId);
  if (!id || !publicCommentsEndpoint(config.endpoint)) return '';
  return `<section class="public-comments" data-public-comments="${id}" aria-labelledby="archived-comments-${id}"><h2 id="archived-comments-${id}">Archived comments</h2><p class="comments-note">Readers’ comments from the previous publication. This archive is read-only; new comments are not accepted.</p><ol data-comments-list></ol><p data-comments-status role="status" tabindex="-1">Loading archived comments…</p><button type="button" class="text-button" data-comments-more hidden>Load more archived comments</button><button type="button" class="text-button" data-comments-retry hidden>Try loading comments again</button></section>`;
}
function renderComment(comment) {
  const item = document.createElement('li');
  const name = document.createElement('strong'); name.className='comment-author'; name.textContent=comment.authorName;
  const time = document.createElement('time'); time.dateTime=comment.commentedAt;
  time.textContent=new Intl.DateTimeFormat('en-NG',{dateStyle:'medium',timeZone:'Africa/Lagos'}).format(new Date(comment.commentedAt));
  const body = document.createElement('p'); body.className='comment-content'; body.textContent=comment.content;
  item.append(name,time,body);
  return item;
}
export function bindPublicComments(root = document, {config = commentsConfig(), fetchImpl = fetch, timeoutMs = 6000} = {}) {
  const disposers = [];
  if (!publicCommentsEndpoint(config.endpoint)) return () => {};
  for (const section of root.querySelectorAll('[data-public-comments]')) {
    if (!publicCommentId(section.dataset.publicComments)) continue;
    const controller = new AbortController(), seen = new Set();
    const list = section.querySelector('[data-comments-list]'), status = section.querySelector('[data-comments-status]');
    const more = section.querySelector('[data-comments-more]'), retry = section.querySelector('[data-comments-retry]');
    let pending = false, disposed = false, nextPage = 1, failedPage = 1, incomplete = false, cooldown = 0, timer;
    function buttons() {
      const seconds = Math.max(0,Math.ceil((cooldown - Date.now()) / 1000));
      retry.disabled = pending || seconds > 0;
      retry.textContent=seconds ? `Try loading comments again in ${seconds}s` : 'Try loading comments again';
      more.disabled=pending;
      if (!seconds && timer) { clearInterval(timer); timer = null; }
    }
    async function load(page, explicit = false) {
      if (disposed || pending || Date.now() < cooldown) return;
      pending=true; buttons(); section.setAttribute('aria-busy','true'); status.textContent='Loading archived comments…';
      try {
        const result = await fetchPublicComments({endpoint:config.endpoint,articleId:section.dataset.publicComments,page,signal:controller.signal,fetchImpl,timeoutMs});
        if (disposed || !section.isConnected) return;
        for (const comment of result.comments) if (!seen.has(comment.id)) { seen.add(comment.id); list.append(renderComment(comment)); }
        nextPage=result.nextPage; incomplete ||= result.incomplete;
        more.hidden=!nextPage; retry.hidden=true;
        status.textContent=result.truncated ? 'More archived comments exist than can be shown here.' : incomplete ? 'Some archived comments could not be displayed.' : seen.size ? `${seen.size} archived comment${seen.size === 1 ? '' : 's'} shown.` : 'No archived comments are available for this article.';
        if (explicit) { if (more.hidden) status.focus(); else more.focus(); }
      } catch (error) {
        if (disposed || error.type === 'cancelled') return;
        failedPage=page; more.hidden=true; retry.hidden=false;
        status.textContent=error.status===429 ? 'Archived comments are busy. Please wait before trying again.' : error.type==='timeout' ? 'Archived comments took too long to load. Please try again later.' : 'Archived comments are temporarily unavailable. Please try again later.';
        if (error.retryAfter) { cooldown=Date.now()+error.retryAfter*1000; timer=setInterval(buttons,1000); }
        if (explicit) status.focus();
      } finally { pending=false; if (!disposed) { section.setAttribute('aria-busy','false'); buttons(); } }
    }
    more.addEventListener('click',() => load(nextPage,true),{signal:controller.signal});
    retry.addEventListener('click',() => load(failedPage,true),{signal:controller.signal});
    load(1);
    disposers.push(() => { disposed=true; controller.abort(); clearInterval(timer); seen.clear(); });
  }
  return () => { for (const dispose of disposers) dispose(); };
}
