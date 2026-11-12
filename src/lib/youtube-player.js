// Imported only after the reader presses play. The address is rebuilt from the already validated ID.
export function playYoutube(button,{dataSaver=false}={}) {
  const figure=button?.closest('[data-youtube-video]');
  const screen=figure?.querySelector('.youtube-video-screen');
  const id=figure?.dataset.youtubeVideo;
  if(!screen || !/^[-_A-Za-z0-9]{11}$/.test(id || '')) return;
  if(navigator.onLine === false) {
    figure.querySelector('.youtube-status').textContent='Video is unavailable while offline.';
    return;
  }
  const params=new URLSearchParams();
  if(!dataSaver) params.set('autoplay','1');
  const start=figure.dataset.youtubeStart;
  if(start && /^\d{1,10}$/.test(start) && Number(start)<=2147483647)params.set('start',start);
  const iframe=document.createElement('iframe');
  iframe.src=`https://www.youtube-nocookie.com/embed/${id}${params.size?'?'+params:''}`;
  iframe.title=button.getAttribute('aria-label') || 'YouTube video';
  iframe.loading='lazy';
  iframe.referrerPolicy='strict-origin-when-cross-origin';
  iframe.allow='autoplay; fullscreen';
  iframe.allowFullscreen=true;
  screen.replaceChildren(iframe);
  iframe.focus();
}
