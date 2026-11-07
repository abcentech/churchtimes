// "Join our WhatsApp group" prompt. The official link (src/lib/social-links.js) is a GROUP INVITE, not a broadcast
// channel, so the wording says so and is honest that members of a group can see each other's phone numbers.
// No third-party script: it is a plain link. Dismissing (or joining) is remembered in this browser only.
import { SOCIAL_LINKS, socialIcon } from '../../lib/social-links.js';
import { writeJSON, whatsappDismissed, WHATSAPP_DISMISS_KEY } from './storage.js';
export { whatsappDismissed };

export const whatsappLink = () => SOCIAL_LINKS.find(link => link.id === 'whatsapp')?.url || '';

export function whatsappPromptHTML(url) {
  return `<aside class="growth-wa" id="growth-wa" aria-labelledby="growth-wa-title"><div class="growth-wa-icon">${socialIcon('whatsapp')}</div><div><h2 id="growth-wa-title">Join our WhatsApp group</h2><p>Get Church Times Nigeria stories in our WhatsApp group. It is a group, so other members can see your phone number. WhatsApp’s terms and privacy policy apply.</p><div class="growth-wa-actions"><a class="button button-dark" href="${url.replace(/"/g, '&quot;')}" target="_blank" rel="noopener noreferrer" data-wa-join>Join the WhatsApp group<span class="sr-only"> (opens WhatsApp in a new tab)</span></a><button type="button" class="text-button" data-wa-dismiss>No thanks</button></div></div></aside>`;
}

/** Inserts the prompt next to `anchor` (`position` as in insertAdjacentHTML); nothing when dismissed, unconfigured or already shown. */
export function mountWhatsappPrompt(anchor, { storage, position = 'afterend' } = {}) {
  const url = whatsappLink();
  if (!url || !anchor?.isConnected || whatsappDismissed(storage) || document.querySelector('#growth-wa')) return null;
  anchor.insertAdjacentHTML(position, whatsappPromptHTML(url));
  const prompt = document.querySelector('#growth-wa');
  const remember = reason => writeJSON(WHATSAPP_DISMISS_KEY, { reason, at: Date.now() }, storage);
  prompt.querySelector('[data-wa-join]').addEventListener('click', () => remember('joined'));
  prompt.querySelector('[data-wa-dismiss]').addEventListener('click', () => {
    remember('dismissed');
    // Keep keyboard users in place: focus moves to the next heading rather than to the top of the page.
    const next = prompt.nextElementSibling?.querySelector?.('h2, a, button') || prompt.parentElement;
    prompt.remove();
    if (next && next.tabIndex < 0 && !/^(A|BUTTON)$/.test(next.tagName)) next.tabIndex = -1;
    next?.focus?.({ preventScroll: true });
  });
  return prompt;
}
