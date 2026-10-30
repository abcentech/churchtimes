// Scripture reference cards for article bodies. Walks TEXT NODES only (article HTML is never re-parsed), wraps each
// valid reference in a button, and shows the bundled KJV text in a small non-modal card on hover, focus or click.
// WCAG 1.4.13: the card is dismissible (Esc, close button, click outside), hoverable and stays until dismissed or the
// pointer/focus leaves both the button and the card. Unknown or out-of-range references stay plain text.
import {findReferences,formatReference} from './refs.js';
import {versesFor,VERSION_LABEL} from './text.js';

const SKIP='a,button,code,pre,kbd,samp,script,style,textarea,input,select,option,svg,math,h1,h2,h3,h4,h5,h6,[contenteditable],[data-no-scripture],.ct-scripture';
const MAX_REFS=200;
let sequence=0;

function textNodes(root){
  const doc=root.ownerDocument||document;
  const walker=doc.createTreeWalker(root,4,{acceptNode:node=>!node.nodeValue || node.nodeValue.length<5 || node.parentElement?.closest(SKIP) ? 2 : 1});
  const nodes=[];
  while(walker.nextNode())nodes.push(walker.currentNode);
  return nodes;
}

/**
 * Links every scripture reference inside `root`. Options: { baseUrl, fetchImpl, limit (verses per card, default 6) }.
 * Returns a dispose function that removes the buttons and restores the original text.
 */
export function mountScriptureRefs(root,{limit=6,...options}={}){
  if(!root)return ()=>{};
  const doc=root.ownerDocument||document,view=doc.defaultView||window;
  const wrappers=[];
  let open=null,hideTimer=0,showTimer=0,returningFocus=false;

  for(const node of textNodes(root)) {
    if(wrappers.length>=MAX_REFS)break;
    const refs=findReferences(node.nodeValue);
    if(!refs.length)continue;
    const fragment=doc.createDocumentFragment();
    let cursor=0;
    for(const ref of refs) {
      if(wrappers.length>=MAX_REFS)break;
      fragment.append(node.nodeValue.slice(cursor,ref.index));
      const wrapper=doc.createElement('span');
      wrapper.className='ct-scripture';
      const button=doc.createElement('button');
      const id=`ct-scripture-${++sequence}`;
      button.type='button';
      button.className='ct-scripture-ref';
      button.textContent=ref.text;
      button.setAttribute('aria-expanded','false');
      button.setAttribute('aria-controls',id);
      button.setAttribute('aria-label',`${ref.text}: show ${formatReference(ref)} (King James Version)`);
      wrapper.append(button);
      wrapper._ref=ref;wrapper._cardId=id;wrapper._original=ref.text;
      wrappers.push(wrapper);
      fragment.append(wrapper);
      cursor=ref.index+ref.length;
    }
    fragment.append(node.nodeValue.slice(cursor));
    node.replaceWith(fragment);
  }

  function buildCard(wrapper){
    const ref=wrapper._ref;
    const card=doc.createElement('span');
    card.className='ct-scripture-card';
    card.id=wrapper._cardId;
    card.setAttribute('role','dialog');
    card.setAttribute('aria-label',`${formatReference(ref)}, King James Version`);
    const head=doc.createElement('span');head.className='ct-scripture-head';
    const title=doc.createElement('strong');title.textContent=formatReference(ref);
    const version=doc.createElement('abbr');version.className='ct-scripture-version';version.title='King James Version';version.textContent='KJV';
    const close=doc.createElement('button');close.type='button';close.className='ct-scripture-close';close.setAttribute('aria-label','Close');close.textContent='×';
    close.addEventListener('click',()=>hide(true));
    head.append(title,' ',version,close);
    const body=doc.createElement('span');body.className='ct-scripture-text';body.setAttribute('aria-live','polite');body.textContent='Loading…';
    const foot=doc.createElement('span');foot.className='ct-scripture-foot';foot.textContent=VERSION_LABEL;
    card.append(head,body,foot);
    card.addEventListener('mouseenter',()=>clearTimeout(hideTimer));
    card.addEventListener('mouseleave',()=>scheduleHide());
    versesFor(ref,{limit,...options}).then(({verses,truncated})=>{
      body.replaceChildren(...verses.map(v=>{
        const line=doc.createElement('span');line.className='ct-scripture-verse';
        const num=doc.createElement('sup');num.textContent=ref.endChapter!==ref.chapter?`${v.chapter}:${v.verse}`:String(v.verse);
        line.append(num,' ',v.text);return line;
      }));
      if(truncated){const more=doc.createElement('span');more.className='ct-scripture-more';more.textContent='…';body.append(more);}
    }).catch(()=>{body.textContent='The verse text could not be loaded. Please check your connection and try again.';card._failed=true;});
    return card;
  }

  function place(wrapper,card){
    card.style.removeProperty('--ct-shift');
    const rect=card.getBoundingClientRect(),gutter=16,width=view.innerWidth||doc.documentElement.clientWidth;
    let shift=0;
    if(rect.right>width-gutter)shift=width-gutter-rect.right;
    if(rect.left+shift<gutter)shift=gutter-rect.left;
    if(shift)card.style.setProperty('--ct-shift',`${Math.round(shift)}px`);
  }

  function show(wrapper,{pinned=false}={}){
    clearTimeout(hideTimer);clearTimeout(showTimer);
    if(open && open!==wrapper)hide(false);
    let card=wrapper.querySelector('.ct-scripture-card');
    if(!card || card._failed){card?.remove();card=buildCard(wrapper);wrapper.append(card);}
    card.hidden=false;
    wrapper.querySelector('.ct-scripture-ref').setAttribute('aria-expanded','true');
    wrapper.classList.add('is-open');
    if(pinned)wrapper.dataset.pinned='true';
    open=wrapper;
    place(wrapper,card);
  }
  function hide(returnFocus){
    clearTimeout(hideTimer);clearTimeout(showTimer);
    if(!open)return;
    const wrapper=open;open=null;
    const card=wrapper.querySelector('.ct-scripture-card');
    if(card)card.hidden=true;
    const button=wrapper.querySelector('.ct-scripture-ref');
    button.setAttribute('aria-expanded','false');
    wrapper.classList.remove('is-open');
    delete wrapper.dataset.pinned;
    // Returning focus to the button must not reopen the card the reader just closed.
    if(returnFocus){returningFocus=true;try{button.focus();}finally{returningFocus=false;}}
  }
  function scheduleHide(){
    if(open?.dataset.pinned)return;
    clearTimeout(hideTimer);hideTimer=setTimeout(()=>hide(false),250);
  }

  const wrapperOf=target=>target instanceof view.Element ? target.closest('.ct-scripture') : null;
  const onClick=event=>{
    const wrapper=wrapperOf(event.target);
    if(wrapper && event.target.closest('.ct-scripture-ref')) {
      if(open===wrapper && wrapper.dataset.pinned)hide(false);else show(wrapper,{pinned:true});
      return;
    }
    if(open && !wrapper)hide(false);
  };
  const onOver=event=>{
    const wrapper=wrapperOf(event.target);
    if(!wrapper || !event.target.closest('.ct-scripture-ref'))return;
    clearTimeout(hideTimer);
    if(open===wrapper)return;
    clearTimeout(showTimer);showTimer=setTimeout(()=>show(wrapper),300);
  };
  const onOut=event=>{
    const wrapper=wrapperOf(event.target);
    if(!wrapper)return;
    if(event.relatedTarget && wrapper.contains(event.relatedTarget))return;
    clearTimeout(showTimer);
    if(open===wrapper)scheduleHide();
  };
  const onFocusIn=event=>{
    const wrapper=wrapperOf(event.target);
    if(!returningFocus && wrapper && event.target.closest('.ct-scripture-ref') && open!==wrapper)show(wrapper);
  };
  const onFocusOut=event=>{
    const wrapper=wrapperOf(event.target);
    if(!wrapper || (event.relatedTarget && wrapper.contains(event.relatedTarget)))return;
    if(open===wrapper){delete wrapper.dataset.pinned;hide(false);}
  };
  const onKey=event=>{if(event.key==='Escape' && open){event.preventDefault();hide(open.contains(doc.activeElement));}};
  const onDocClick=event=>{if(open && !wrapperOf(event.target))hide(false);};

  root.addEventListener('click',onClick);
  root.addEventListener('mouseover',onOver);
  root.addEventListener('mouseout',onOut);
  root.addEventListener('focusin',onFocusIn);
  root.addEventListener('focusout',onFocusOut);
  doc.addEventListener('keydown',onKey);
  doc.addEventListener('click',onDocClick);

  return ()=>{
    hide(false);
    root.removeEventListener('click',onClick);
    root.removeEventListener('mouseover',onOver);
    root.removeEventListener('mouseout',onOut);
    root.removeEventListener('focusin',onFocusIn);
    root.removeEventListener('focusout',onFocusOut);
    doc.removeEventListener('keydown',onKey);
    doc.removeEventListener('click',onDocClick);
    for(const wrapper of wrappers) {
      if(!wrapper.isConnected)continue;
      const parent=wrapper.parentNode;
      wrapper.replaceWith(doc.createTextNode(wrapper._original));
      parent.normalize();
    }
  };
}
