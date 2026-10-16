export async function copyShareLink(input, status, clipboard = globalThis.navigator?.clipboard) {
  try { await clipboard.writeText(input.value); status.textContent='Link copied.'; return true; }
  catch { input.focus(); input.select(); status.textContent='Copy is unavailable. The link is selected; use your device’s Copy command.'; return false; }
}
export function mountListen(root, { window: win = window } = {}) {
  const content=root.querySelector('.article-body');
  const tools=root.querySelector('.article-tools, .article-meta');
  if(!content || !tools || !win.speechSynthesis || !win.SpeechSynthesisUtterance) return ()=>{};
  const button=root.ownerDocument.createElement('button'); button.type='button';button.className='outline-button';button.textContent='Listen';button.hidden=true;tools.append(button);
  let voices=[],playing=false,disposed=false;
  const reset=()=>{playing=false;button.textContent='Listen';};
  function refreshVoices(){
    try {voices=win.speechSynthesis.getVoices().filter(voice=>voice.localService);} catch {voices=[];}
    button.hidden=!voices.length;button.style.display=voices.length?'':'none';
    if(!voices.length && playing){win.speechSynthesis.cancel();reset();}
  }
  refreshVoices();win.speechSynthesis.addEventListener?.('voiceschanged',refreshVoices);
  button.addEventListener('click',()=>{
    if(disposed)return;
    if(playing){win.speechSynthesis.cancel();reset();return;}
    refreshVoices();if(!voices.length)return;
    try {
      const readable=content.cloneNode(true);
      readable.querySelectorAll('.advertising-slot,[data-ad-placement],.original-callout,.article-tags,.newsroom-article-end,button,script,style').forEach(node=>node.remove());
      const speech=new win.SpeechSynthesisUtterance(readable.textContent.slice(0,50000));speech.voice=voices.find(v=>v.lang.startsWith('en'))||voices[0];
      speech.onend=reset;speech.onerror=reset;win.speechSynthesis.speak(speech);playing=true;button.textContent='Stop listening';
    } catch { button.hidden=true;button.style.display='none'; }
  });
  return ()=>{disposed=true;win.speechSynthesis.removeEventListener?.('voiceschanged',refreshVoices);win.speechSynthesis.cancel();};
}
