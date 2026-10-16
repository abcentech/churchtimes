// A relative #main anchor resolves against <base>, which can leave a clean
// article URL. Keep enhanced skip navigation in the current document.
export function bindSkipLink(root=document) {
  root.querySelector('.skip-link')?.addEventListener('click',event=>{
    const main=root.querySelector('#main');
    if(!main)return;
    event.preventDefault();main.focus({preventScroll:true});main.scrollIntoView({block:'start',behavior:'instant'});
  });
}
