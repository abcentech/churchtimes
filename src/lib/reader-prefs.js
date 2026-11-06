// Display preferences: theme, contrast and article text size, saved on this device only (no account, no server).
// The inline head script (src/index.template.html, #reader-prefs-bootstrap) applies the same keys before first paint.
export const TEXT_STEPS=['Smaller','Default','Large','Larger','Largest'];
const KEYS={theme:'ct-theme',contrast:'ct-contrast',text:'ct-text'};
export function readPrefs(storage=globalThis.localStorage) {
  const get=key=>{try{return storage?.getItem(key);}catch{return null;}};
  const theme=get(KEYS.theme),contrast=get(KEYS.contrast),text=get(KEYS.text);
  return {theme:['light','dark'].includes(theme)?theme:'system',contrast:['more','normal'].includes(contrast)?contrast:'system',text:/^[0-4]$/.test(text||'')?Number(text):1};
}
// Same decision the head bootstrap makes; exported for tests and the no-storage path.
export function resolvePrefs(prefs,{prefersDark=false,prefersMore=false}={}) {
  return {theme:prefs.theme==='system'?(prefersDark?'dark':'light'):prefs.theme,contrast:prefs.contrast==='more'||(prefs.contrast==='system'&&prefersMore)?'more':null,text:prefs.text===1?null:String(prefs.text)};
}
export function applyPrefs(prefs,{root=document.documentElement,storage=globalThis.localStorage,media=query=>matchMedia(query).matches}={}) {
  let stored=true;
  try {
    for(const [name,value] of Object.entries({theme:prefs.theme==='system'?null:prefs.theme,contrast:prefs.contrast==='system'?null:prefs.contrast,text:prefs.text===1?null:String(prefs.text)})) {
      if(value===null)storage.removeItem(KEYS[name]);else storage.setItem(KEYS[name],value);
    }
  } catch {stored=false;}
  const resolved=resolvePrefs(prefs,{prefersDark:media('(prefers-color-scheme: dark)'),prefersMore:media('(prefers-contrast: more)')});
  root.dataset.theme=resolved.theme;
  if(resolved.contrast)root.dataset.contrast=resolved.contrast;else delete root.dataset.contrast;
  if(resolved.text)root.dataset.text=resolved.text;else delete root.dataset.text;
  return stored;
}
const radio=(name,value,label,checked)=>`<label class="reader-choice"><input type="radio" name="${name}" value="${value}" ${checked?'checked':''}><span>${label}</span></label>`;
export function settingsMarkup(prefs) {
  return `<div class="dialog-bar"><h2 id="reader-settings-title">Display settings</h2><button type="button" class="icon-button" data-close aria-label="Close display settings"><svg class="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button></div>
<form class="reader-settings-form" method="dialog">
<fieldset><legend>Theme</legend><div class="reader-choices">${radio('theme','system','Match device',prefs.theme==='system')}${radio('theme','light','Light',prefs.theme==='light')}${radio('theme','dark','Dark',prefs.theme==='dark')}</div></fieldset>
<fieldset><legend>Contrast</legend><div class="reader-choices">${radio('contrast','system','Match device',prefs.contrast==='system')}${radio('contrast','normal','Standard',prefs.contrast==='normal')}${radio('contrast','more','High',prefs.contrast==='more')}</div></fieldset>
<fieldset><legend>Article text size</legend><div class="reader-choices reader-text-steps">${TEXT_STEPS.map((label,index)=>radio('text',index,`<span class="reader-text-sample" data-step="${index}" aria-hidden="true">A</span>${label}`,prefs.text===index)).join('')}</div></fieldset>
<p class="reader-settings-note">Saved on this device only. Text size applies to article pages.</p><p class="reader-settings-status" role="status"></p>
</form>`;
}
