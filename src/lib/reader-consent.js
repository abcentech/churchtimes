// Optional services default off. Only explicit, versioned choices persist locally.
const key = 'ct-optional-consent-v1';
let choices = { analytics: false, forms: false, push: false };
try { const value = JSON.parse(localStorage.getItem(key)); for (const category of Object.keys(choices)) choices[category] = value?.[category] === true; } catch {}
const listeners = new Set();
export const hasConsent = category => choices[category] === true;
export function subscribeConsent(callback) { listeners.add(callback); return () => listeners.delete(callback); }
export function setConsent(category, value) {
  if (!(category in choices)) return;
  choices = { ...choices, [category]: value === true };
  try { localStorage.setItem(key, JSON.stringify(choices)); } catch {}
  for (const callback of listeners) callback(choices);
}
export function requestConsent() { document.querySelector('#privacy-dialog')?.showModal(); }
export const consentMarkup = () => `<fieldset><legend>Optional services — off unless you choose</legend><label><input type="checkbox" data-consent="analytics" ${hasConsent('analytics')?'checked':''}> Allow configured audience analytics</label><label><input type="checkbox" data-consent="forms" ${hasConsent('forms')?'checked':''}> Allow Cloudflare spam protection for online forms</label>${/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(import.meta.env?.VITE_PUBLIC_ONESIGNAL_APP_ID||'')?`<label><input type="checkbox" data-consent="push" ${hasConsent('push')?'checked':''}> Allow optional push notifications</label>`:''}<p>Changing a choice saves it in this browser. Turning analytics off stops new events; reload to remove an already loaded provider.</p></fieldset>`;
let unbindControls;
export function bindConsentControls(root = document) {
  unbindControls?.();
  const controls=[...root.querySelectorAll('[data-consent]')];
  const sync=()=>controls.forEach(input=>{input.checked=hasConsent(input.dataset.consent);});
  sync();
  unbindControls=subscribeConsent(sync);
  root.querySelectorAll('[data-consent]').forEach(input => input.addEventListener('change', () => setConsent(input.dataset.consent,input.checked)));
}
