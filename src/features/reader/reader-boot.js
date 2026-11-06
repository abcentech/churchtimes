// Eager, tiny: opens the lazy display-settings dialog and, only where scroll-driven
// animations are unsupported, loads the reading-progress fallback. Everything else is lazy.
document.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-reader-settings]');
  if(button)import('./reader-prefs.js').then(module=>module.openReaderSettings(button)).catch(()=>{});
});
if(!globalThis.CSS?.supports?.('animation-timeline:view()'))import('./reader-progress.js').catch(()=>{});
