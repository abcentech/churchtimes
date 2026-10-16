export async function copyShareLink(input, status, clipboard = globalThis.navigator?.clipboard) {
  try { await clipboard.writeText(input.value); status.textContent='Link copied.'; return true; }
  catch { input.focus(); input.select(); status.textContent='Copy is unavailable. The link is selected; use your device’s Copy command.'; return false; }
}
export function mountListen(root, { window: win = window } = {}) {
  const content=root.querySelector('.article-body');
  const tools=root.querySelector('.article-tools, .article-meta');
  if(!content || !tools || !win.speechSynthesis || !win.SpeechSynthesisUtterance) return ()=>{};
  const voices=win.speechSynthesis.getVoices().filter(voice=>voice.localService);
  // Only on-device voices: never silently send article text to a speech provider.
  if(!voices.length) return ()=>{};
  const button=root.ownerDocument.createElement('button'); button.type='button';button.className='outline-button';button.textContent='Listen'; button.setAttribute('aria-pressed','false'); tools.append(button);
  button.addEventListener('click',()=>{
    if(button.getAttribute('aria-pressed')==='true'){win.speechSynthesis.cancel();button.textContent='Listen';button.setAttribute('aria-pressed','false');return;}
    try {
      const speech=new win.SpeechSynthesisUtterance(content.textContent.slice(0,50000));speech.voice=voices.find(v=>v.lang.startsWith('en'))||voices[0];
      const reset=()=>{button.textContent='Listen';button.setAttribute('aria-pressed','false');};speech.onend=reset;speech.onerror=reset;
      win.speechSynthesis.speak(speech);button.textContent='Stop listening';button.setAttribute('aria-pressed','true');
    } catch { button.remove(); }
  });
  return ()=>win.speechSynthesis.cancel();
}
