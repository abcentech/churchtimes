// Public, already-approved delivery data only. No billing, tracking, or script loader.
export const placements = Object.freeze({
  'homepage-billboard': { desktop: [970, 250], mobile: [320, 100] },
  'article-inline': { desktop: [728, 90], mobile: [320, 100] },
  'mobile-banner': { mobile: [320, 50] },
});
const escape = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

function safeURL(value, local = false) {
  if (typeof value !== 'string') return null;
  if (local && /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/.test(value) &&
      !value.split('/').includes('..')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function selectDirectCampaign(placement, campaigns = [], now = Date.now()) {
  const spec = placements[placement];
  if (!spec || !Array.isArray(campaigns)) return null;
  return campaigns.filter(campaign => {
    if (!campaign || campaign.status !== 'active' || !Array.isArray(campaign.placements) || !campaign.placements.includes(placement) ||
        !text(campaign.sponsor, 100) || !text(campaign.alt, 240) || !safeURL(campaign.destinationUrl)) return false;
    const start = Date.parse(campaign.startsAt), end = Date.parse(campaign.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > now || end <= now) return false;
    return Object.entries(spec).every(([viewport, dimensions]) => {
      const image = campaign.creatives?.[placement]?.[viewport];
      return image && image.width === dimensions[0] && image.height === dimensions[1] && safeURL(image.src, true);
    });
  }).sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0) ||
    String(a.id).localeCompare(String(b.id)))[0] || null;
}

export function createAdvertisingSlot(placement, config = {}, {
  document: doc = document, resolveAsset = path => path, now = Date.now(), reviewedAdSense,
} = {}) {
  const spec = placements[placement];
  if (!spec || !config || typeof config !== 'object') return null;
  const campaign = selectDirectCampaign(placement, config.campaigns, now);
  let creative, sponsor;
  if (campaign) {
    const images = campaign.creatives[placement];
    const desktop = images.desktop || images.mobile;
    const src = image => { const url = safeURL(image.src, true); return escape(url.startsWith('https:') ? url : resolveAsset(url)); };
    const wrapper = doc.createElement('a');
    wrapper.href = safeURL(campaign.destinationUrl);
    wrapper.target = '_blank';
    wrapper.rel = 'sponsored noopener noreferrer';
    wrapper.setAttribute('aria-label', `Advertisement from ${text(campaign.sponsor, 100)}: ${text(campaign.alt, 240)} (opens in a new tab)`);
    wrapper.innerHTML = `<picture>${images.desktop ? `<source media="(max-width: 760px)" srcset="${src(images.mobile)}" width="${images.mobile.width}" height="${images.mobile.height}">` : ''}<img src="${src(desktop)}" width="${desktop.width}" height="${desktop.height}" alt="${escape(text(campaign.alt, 240))}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></picture>`;
    creative = wrapper;
    sponsor = text(campaign.sponsor, 100);
  } else if (config.adsense?.enabled === true && config.adsense?.reviewed === true && reviewedAdSense) {
    // Only consume a ready, filled unit from an independently reviewed integration.
    // Never create an <ins>, set publisher/slot IDs, load a script, or request an ad.
    try { creative = reviewedAdSense.getFilledSlot(placement); } catch { return null; }
    if (!creative || creative.ownerDocument !== doc || creative.tagName !== 'INS' ||
        creative.isConnected || creative.dataset.adStatus !== 'filled' ||
        !creative.classList.contains('adsbygoogle') || creative.querySelector('script')) return null;
    sponsor = 'Google AdSense';
  } else return null;

  const slot = doc.createElement('aside');
  slot.className = `advertising-slot advertising-slot--${placement}`;
  slot.dataset.adPlacement = placement;
  slot.setAttribute('aria-label', `${placement === 'article-inline' ? 'Article' : 'Homepage'} advertisement`);
  slot.innerHTML = `<div class="advertising-label"><span>Advertisement</span><span>${escape(sponsor)}</span></div><div class="advertising-creative"></div>`;
  slot.querySelector('.advertising-creative').append(creative);
  creative.querySelector('img')?.addEventListener('error', () => slot.remove(), { once: true });
  return slot;
}

export function mountAdvertisingPlacements(root, config, options) {
  root.querySelectorAll('template[data-ad-placement]').forEach(marker => {
    const slot = createAdvertisingSlot(marker.dataset.adPlacement, config, options);
    if (slot) marker.replaceWith(slot);
    else marker.remove(); // No empty slot, label, request, or reserved gap.
  });
}
