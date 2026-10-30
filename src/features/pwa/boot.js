// Initial-bundle PWA hooks, kept tiny for the reader budget. Everything optional lives in enhance.js (lazy, idle).
import {LITE_KEY,liteHTML} from './lite.js';
import {setCMSImageFilter} from '../../lib/cms-media.js';
let pref;
try {pref=localStorage.getItem(LITE_KEY);} catch {}
// Data saver: the reader's choice wins; otherwise follow the browser's Save-Data signal (Chromium only).
let lite=pref==='on'||(pref!=='off'&&navigator.connection?.saveData===true);
export const isLite=()=>lite;
export const setLiteFlag=on=>{lite=on;};
export const liteMarkup=html=>lite?liteHTML(html):html;
setCMSImageFilter(liteMarkup);
// Data saver: optional heavy chunks (comments) wait for an explicit tap.
export function liteGate(root,label,run) {
  if(!lite)return run();
  const button=document.createElement('button');button.type='button';button.className='outline-button';button.textContent=label;
  button.addEventListener('click',()=>{button.remove();run();},{once:true});root.append(button);
}
// Article links become real document navigations where that is faster or works offline (speculation rules
// prefetch/prerender, a controlling service worker, or no network). Otherwise the shell intercepts them.
export const documentNav=()=>!!navigator.serviceWorker?.controller||!navigator.onLine||(!lite&&!!HTMLScriptElement.supports?.('speculationrules'));
let enhance;
const more=()=>enhance||=import('./enhance.js');
// main.js calls this once in place of its first render(): a prerendered page waits for activation
// before it renders, counts analytics or loads ads.
export function startPWA(render) {
  const run=()=>{
    render();
    document.addEventListener('click',event=>{if(event.target.closest?.('[data-lite-toggle]'))more().then(m=>m.toggleLite()).catch(()=>{});});
    const load=()=>more().then(m=>m.startEnhance()).catch(()=>{});
    const idle=()=>(window.requestIdleCallback||setTimeout)(load,{timeout:3000});
    if(document.readyState==='complete')idle();else addEventListener('load',idle,{once:true});
  };
  if(document.prerendering)document.addEventListener('prerenderingchange',run,{once:true});else run();
}
