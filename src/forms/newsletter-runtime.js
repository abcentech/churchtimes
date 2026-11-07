// The settings response is public; credentials and subscriber data never enter it.
import {readerFormConfig,newsletterMarkup,bindReaderForms} from './reader-forms.js';
const requests=new WeakMap();
async function configFor({cmsUrl,signal}) {
  const base=readerFormConfig();
  if(!cmsUrl)return base.newsletter && base.siteKey ? base : null;
  try {
    const url=new URL('/api/public/newsletter/settings',cmsUrl);
    const response=await fetch(url,{credentials:'omit',cache:'no-store',signal});
    if(!response.ok)return null;
    const settings=await response.json();
    const key=typeof settings.siteKey==='string' && /^[A-Za-z0-9_-]{1,255}$/.test(settings.siteKey) ? settings.siteKey : base.siteKey;
    return settings.enabled===true && base.newsletter && key ? {...base,siteKey:key} : null;
  } catch {return null;}
}
export async function hydrateNewsletters(root,options) {
  let pending=requests.get(options.signal);
  if(!pending){pending=configFor(options);requests.set(options.signal,pending);}
  const config=await pending;
  if(!config || options.signal.aborted || !root.isConnected)return;
  for(const slot of root.querySelectorAll('[data-newsletter-slot]')) {
    if(slot.dataset.newsletterMounted)continue;
    slot.dataset.newsletterMounted='true';
    slot.innerHTML=newsletterMarkup(slot.dataset.newsletterSlot,config);
    const dispose=bindReaderForms(slot,{...options,config});
    if(options.signal.aborted)dispose();else options.disposers.push(dispose);
  }
}
