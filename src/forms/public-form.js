import { FIELD_LIMITS, validateSubmission, sendPublicSubmission } from '../lib/public-submissions.js';
import { mountTurnstile } from '../lib/turnstile.js';

import {publicFormConfig as config} from './public-form-markup.js';
export {publicFormMarkup} from './public-form-markup.js';
import './public-form.css';

export function bindPublicForm(kind='story') {
  const { endpoint, siteKey, action } = config(kind);
  const form = document.querySelector('#public-form');
  const summary = document.querySelector('#form-errors');
  const status = document.querySelector('#submission-status');
  const button = document.querySelector('#send-submission');
  const challengeStatus = document.querySelector('#challenge-status');
  const restart = document.querySelector('#retry-challenge');
  const abortController = new AbortController();
  let token = '';
  let pending = false;
  let disposed = false;
  let cooldownUntil = 0;
  let countdown;
  let challenge;
  const ready = Boolean(endpoint && siteKey);
  function challengeMessage(message, retry=false) {
    challengeStatus.textContent = message;
    restart.hidden = !retry;
  }
  if (ready) challenge = mountTurnstile(document.querySelector('#turnstile-widget'), {
    siteKey, action,
    onToken(value) { token=value; challengeMessage('Verification complete. You can send your submission.'); },
    onReady() { if (!token) challengeMessage('Complete the verification challenge before sending.'); },
    onExpired() { token=''; challengeMessage('Verification expired. Restart it before sending.',true); },
    onError() { token=''; challengeMessage('Verification could not load. Restart it, or email the newsroom if it stays unavailable.',true); },
  });
  restart.addEventListener('click',()=> {
    if (pending) return;
    token=''; challengeMessage('Loading a new verification challenge…'); challenge?.reset();
  });
  function showErrors(errors, general='') {
    for (const name of Object.keys(FIELD_LIMITS).concat(['category','consent'])) {
      const input = form.elements.namedItem(name);
      const error = document.querySelector(`#error-${name}`);
      if (!input || !error) continue;
      input.setAttribute('aria-invalid',String(Boolean(errors[name])));
      error.textContent=errors[name] || '';
      error.hidden=!errors[name];
    }
    const list=summary.querySelector('ul');
    list.replaceChildren();
    for (const [name,message] of Object.entries(errors)) {
      const item=document.createElement('li');
      const link=document.createElement('a');
      link.textContent=message;
      link.href=name==='challenge'?'#public-verification':`#public-${name}`;
      link.addEventListener('click',event=> {
        event.preventDefault();
        document.getElementById(name==='challenge'?'public-verification':`public-${name}`)?.focus();
      });
      item.append(link); list.append(item);
    }
    if (general) { const item=document.createElement('li'); item.textContent=general; list.append(item); }
    summary.hidden=!list.children.length;
    if (!summary.hidden) summary.focus();
  }
  function updateButton() {
    const seconds=Math.max(0,Math.ceil((cooldownUntil-Date.now())/1000));
    button.disabled=!ready || pending || seconds>0;
    button.textContent=pending?'Sending…':seconds>0?`Try again in ${seconds}s`:kind==='story'?'Submit for editorial review':'Send message';
    if (!seconds && countdown) { clearInterval(countdown); countdown=undefined; status.textContent='You can try again. Complete a new verification challenge first.'; }
  }
  form.addEventListener('submit',async event=> {
    event.preventDefault();
    if (!ready || pending || disposed || Date.now()<cooldownUntil) return;
    const values=Object.fromEntries(new FormData(form));
    values.consent=form.elements.consent.checked;
    const errors=validateSubmission(values,kind);
    if (!token) errors.challenge='Complete the spam-protection challenge before sending.';
    showErrors(errors);
    if (Object.keys(errors).length) return;
    pending=true;
    updateButton();
    restart.disabled=true;
    form.setAttribute('aria-busy','true');
    form.querySelector('fieldset').disabled=true;
    status.textContent='Sending your submission. Please wait…';
    try {
      const receipt=await sendPublicSubmission({endpoint,values,token,kind,signal:abortController.signal});
      if (disposed) return;
      form.reset();
      form.hidden=true;
      const result=document.querySelector('#form-result');
      const heading=document.createElement('h2');
      heading.textContent=kind==='story'?'Your story is awaiting review.':'Your message has been received.';
      const message=document.createElement('p');
      message.textContent='Thank you. The newsroom will review your submission. It has not been published.';
      result.replaceChildren(heading,message);
      if (receipt.reference) { const reference=document.createElement('p'); reference.textContent=`Reference: ${receipt.reference}`; result.append(reference); }
      const link=document.createElement('a'); link.href='#home'; link.className='text-link'; link.textContent='Return to the current edition'; result.append(link);
      result.hidden=false; result.focus();
      challenge?.dispose();
    } catch(error) {
      if (disposed) return;
      const messages={
        duplicate:'The newsroom already received a matching submission. Please contact the newsroom if you need to add information; no new submission was created.',
        size:'Your submission is too large to send. Shorten the message and try again.',
        forbidden:'This service cannot accept submissions from this website right now. Please email the newsroom.',
        configuration:'Online sending is not configured correctly. Please email the newsroom.',
        'rate-limit':'Too many submissions have been sent. Please wait before trying again.',
        challenge:'Verification was not accepted. Complete a new challenge and try again.',
        validation:'The newsroom could not accept these details. Please check the form.',
        server:'The service is temporarily unavailable. Your text remains in this form. Please try again later.',
        timeout:'The service took too long to respond. Your text remains here. Contact the newsroom before resending to avoid duplicates.',
        network:'We could not confirm whether your submission was received. Your text remains here. Contact the newsroom before resending to avoid duplicates.',
        unconfirmed:'The service did not confirm receipt. Your text remains here. Contact the newsroom before resending.',
      };
      showErrors(error.fields || {},messages[error.type] || 'Your submission could not be sent. Please try again later.');
      if (error.type==='rate-limit') {
        cooldownUntil=Date.now()+error.retryAfter*1000;
        countdown=setInterval(updateButton,1000);
      }
      status.textContent=error.type==='rate-limit'?`Please wait ${error.retryAfter} seconds before sending again.`:'';
    } finally {
      token=''; pending=false;
      if (!disposed) {
        form.setAttribute('aria-busy','false');
        form.querySelector('fieldset').disabled=false;
        restart.disabled=false;
        updateButton();
        if (!form.hidden) { challengeMessage('Complete a new verification challenge before sending again.',true); challenge?.reset(); }
      }
    }
  });
  return () => {
    disposed=true; token=''; abortController.abort(); clearInterval(countdown); challenge?.dispose();
    // Release the current form's values on navigation; never persist them.
    form.reset();
  };
}
