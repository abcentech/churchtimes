// Reading-progress fallback for browsers without scroll-driven animations (src/reader-ui.css draws the bar).
export function articleProgress(box,viewportHeight) {
  const span=box.height-viewportHeight;
  return span>0?Math.min(1,Math.max(0,-box.top/span)):box.top<viewportHeight?1:0;
}
let queued=false;
const update=()=>{
  queued=false;
  const node=document.querySelector('.article-page,.newsroom-report article');
  if(node)node.style.setProperty('--reader-progress',String(articleProgress(node.getBoundingClientRect(),innerHeight)));
};
if(typeof addEventListener==='function')addEventListener('scroll',()=>{if(!queued){queued=true;requestAnimationFrame(update);}},{passive:true});
