import '../share-bar.css';
import {socialLinksHTML} from './social-links.js';
export {shareBarHTML,bindShareBar} from './share-bar.js';
export function mountFooterSocial(root=document) {
  for(const el of root.querySelectorAll('[data-social-links]:not([data-ready])')) {
    el.dataset.ready='';
    el.innerHTML=`<span class="eyebrow" id="follow-label">FOLLOW US</span>${socialLinksHTML().replace('<ul ','<ul aria-labelledby="follow-label" ')}`;
  }
}
