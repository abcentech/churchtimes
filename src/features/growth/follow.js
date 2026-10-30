// "Follow" buttons for topics and authors. Contract for any page (topic pages here, author pages from the reader lane):
//   <button type="button" hidden data-follow-kind="topic|author" data-follow-slug="{slug}" data-follow-name="{display name}"></button>
// Rendered `hidden` so it is never dead UI without JavaScript; bindFollowButtons() reveals it, labels it and keeps
// aria-pressed in sync. Follows live only in this browser (localStorage `ct-following`); nothing is sent anywhere.
import { isFollowing, toggleFollow } from './storage.js';

const label = (following, name) => following ? `Following ${name}` : `Follow ${name}`;
function paint(button) {
  const following = isFollowing(button.dataset.followKind, button.dataset.followSlug);
  const name = button.dataset.followName || button.dataset.followSlug;
  button.setAttribute('aria-pressed', String(following));
  button.classList.add('growth-follow');
  button.classList.toggle('is-following', following);
  button.textContent = following ? 'Following' : 'Follow';
  button.setAttribute('aria-label', label(following, name));
}

const bound = new WeakSet();
export function bindFollowButtons(root = document, { announce } = {}) {
  const buttons = [...root.querySelectorAll('button[data-follow-kind][data-follow-slug]')].filter(b => ['topic', 'author'].includes(b.dataset.followKind));
  for (const button of buttons) {
    paint(button);
    button.hidden = false;
    if (bound.has(button)) continue;
    bound.add(button);
    button.addEventListener('click', () => {
      const name = button.dataset.followName || button.dataset.followSlug;
      const { following, saved } = toggleFollow({ kind: button.dataset.followKind, slug: button.dataset.followSlug, name });
      for (const other of root.querySelectorAll('button[data-follow-kind][data-follow-slug]')) {
        if (other.dataset.followKind === button.dataset.followKind && other.dataset.followSlug === button.dataset.followSlug) paint(other);
      }
      const message = !saved ? 'Your browser did not allow saving this choice.' : following ? `You are following ${name}. New stories appear under “Following” on the home page.` : `You stopped following ${name}.`;
      (announce || defaultAnnounce)(message);
    });
  }
  return buttons.length;
}

function defaultAnnounce(message) {
  // The site shell's toast is already a polite live region; use it when present so nothing is announced twice.
  const toast = document.querySelector('#toast');
  if (toast) { toast.textContent = message; toast.classList.add('visible'); clearTimeout(defaultAnnounce.timer); defaultAnnounce.timer = setTimeout(() => toast.classList.remove('visible'), 3000); return; }
  let region = document.querySelector('#growth-announce');
  if (!region) {
    region = document.createElement('p');
    region.id = 'growth-announce';
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    document.body.append(region);
  }
  region.textContent = '';
  // A fresh text node on the next frame makes screen readers repeat identical messages.
  requestAnimationFrame(() => { region.textContent = message; });
}

export function followButtonHTML({ kind, slug, name }, escape) {
  return `<button type="button" class="growth-follow outline-button" hidden data-follow-kind="${escape(kind)}" data-follow-slug="${escape(slug)}" data-follow-name="${escape(name)}">Follow</button>`;
}
