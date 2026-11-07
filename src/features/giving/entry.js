// The only giving module the main bundle references (keeps the initial-JS cost to a few bytes). Each feature loads
// its own chunk from here.
export function page() {
  const root = document.querySelector('[data-give]');
  if (!root) return;
  const thanks = (location.pathname + location.hash).includes('give/thanks');
  import('./give-page.js').then(m => { if (root.isConnected) m.mountGive(root, { thanks }); }).catch(() => {
    if (root.isConnected) root.insertAdjacentHTML('beforeend', '<p role="alert">Online giving could not load. Please check your connection and try again.</p>');
  });
}

export function ask() {
  return import('./ask.js').then(m => m.mountGivingAsk()).catch(() => {});
}
