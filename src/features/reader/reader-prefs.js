// Lazy display-settings dialog (loaded on first click of the Display settings button).
import './reader-prefs.css';
import {readPrefs,applyPrefs,settingsMarkup} from '../../lib/reader-prefs.js';
export function openReaderSettings(trigger) {
  let dialog=document.querySelector('#reader-settings');
  if(!dialog) {
    dialog=document.createElement('dialog');dialog.id='reader-settings';dialog.className='reader-settings';dialog.setAttribute('aria-labelledby','reader-settings-title');
    document.body.append(dialog);
  }
  dialog.innerHTML=settingsMarkup(readPrefs());
  const note=dialog.querySelector('.reader-settings-status');
  dialog.querySelector('form').addEventListener('change',()=>{
    const form=new FormData(dialog.querySelector('form'));
    const stored=applyPrefs({theme:form.get('theme'),contrast:form.get('contrast'),text:Number(form.get('text'))});
    note.textContent=stored?'':'Applied for this visit only: browser storage is unavailable.';
  });
  dialog.querySelector('[data-close]').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{trigger?.setAttribute('aria-expanded','false');if(trigger?.isConnected)trigger.focus();},{once:true});
  trigger?.setAttribute('aria-expanded','true');
  dialog.showModal();
  dialog.querySelector('input:checked')?.focus();
  return dialog;
}
