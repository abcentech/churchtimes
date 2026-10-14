import { FIELD_LIMITS, STORY_CATEGORIES, submissionEndpoint, validateSubmission, sendPublicSubmission } from '../lib/public-submissions.js';
import { mountTurnstile } from '../lib/turnstile.js';

const config = kind => ({
  endpoint: submissionEndpoint({ kind, cmsUrl:import.meta.env.VITE_PUBLIC_CMS_URL,
    storyUrl:import.meta.env.VITE_PUBLIC_SUBMISSIONS_URL, contactUrl:import.meta.env.VITE_PUBLIC_CONTACT_URL }),
  siteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
  action: import.meta.env.VITE_TURNSTILE_ACTION || (kind === 'story' ? 'submit-story' : 'submit-contact'),
});
const textField = (name, label, type='text', autocomplete='off') => `<div class="public-field"><label for="public-${name}">${label} <span>(required)</span></label><input id="public-${name}" name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${FIELD_LIMITS[name]}" required aria-describedby="error-${name}"><p class="field-error" id="error-${name}" hidden></p></div>`;

export function publicFormMarkup(kind='story') {
  const story = kind === 'story';
  const available = config(kind).endpoint && config(kind).siteKey;
  return `<section class="container public-form-section" aria-labelledby="public-form-title">
    <aside class="public-form-aside"><span class="eyebrow clay">${story?'SHARE A STORY':'WRITE TO THE NEWSROOM'}</span><h2 id="public-form-title">${story?'Help us follow the story.':'Let’s start a conversation.'}</h2><p>${story?'Tell us what happened, where it happened and why it matters. Include source links in your text where possible.':'Ask a question, suggest a correction or send an enquiry. For a correction, include the article link.'}</p><div class="form-review-note"><strong>Every public submission requires editorial review.</strong><p>Nothing you send here is published automatically. The newsroom may contact you for more information.</p></div><p class="small">Your details are sent only when you submit. This form does not save drafts in browser storage.</p><a class="text-link" href="mailto:info@churchtimesnigeria.net">Email the newsroom instead</a></aside>
    <div class="public-form-panel">
      ${!available?'<div class="form-notice" role="status"><strong>Online sending is not available yet.</strong><p>You can read the form below, or email info@churchtimesnigeria.net to contact the newsroom. No information will be sent from this form until online sending is available.</p></div>':''}
      <div id="form-result" tabindex="-1" hidden></div>
      <form id="public-form" novalidate>
        <div id="form-errors" class="form-error-summary" tabindex="-1" role="alert" hidden><h3>Please check your submission.</h3><ul></ul></div>
        <fieldset id="public-fields"><legend class="sr-only">${story?'Story submission':'Contact message'}</legend>
          <div class="public-field-row">${textField('name','Your name','text','name')}${textField('email','Email address','email','email')}</div>
          <div class="public-field"><label for="public-phone">Phone number <span>(required)</span></label><p class="field-hint" id="phone-hint">Add a number where the newsroom can contact you about your submission. Include your country code for international numbers.</p><input id="public-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="${FIELD_LIMITS.phone}" required aria-describedby="phone-hint error-phone"><p class="field-error" id="error-phone" hidden></p></div>
          ${textField('title',story?'Headline or story subject':'Subject')}
          ${story?'<div class="public-field"><label for="public-location">Location <span>(optional)</span></label><input id="public-location" name="location" maxlength="120" autocomplete="address-level2" aria-describedby="error-location"><p id="error-location" class="field-error" hidden></p></div>':''}
          ${story?`<div class="public-field"><label for="public-category">Section <span>(required)</span></label><select id="public-category" name="category" required aria-describedby="error-category"><option value="">Choose a section</option>${STORY_CATEGORIES.map(value=>`<option>${value}</option>`).join('')}</select><p id="error-category" class="field-error" hidden></p></div>`:''}
          <div class="public-field"><label for="public-message">${story?'Your story or tip':'Your message'} <span>(required)</span></label><p class="field-hint" id="message-hint">${story?'Include the key facts and any source links.':'Include enough detail for the newsroom to understand your enquiry.'} Include at least 30 characters; maximum 20,000 characters. Please do not include passwords or payment details.</p><textarea id="public-message" name="message" rows="10" maxlength="20000" required aria-describedby="message-hint error-message"></textarea><p id="error-message" class="field-error" hidden></p></div>
          <div class="public-field consent-field"><label for="public-consent"><input id="public-consent" type="checkbox" name="consent" required aria-describedby="error-consent"><span>I agree that the newsroom may use my details to review this submission and contact me about it.</span></label><p id="error-consent" class="field-error" hidden></p></div>
        </fieldset>
        <div class="form-verification" id="public-verification" tabindex="-1" role="group" aria-label="Spam protection" aria-describedby="challenge-status"><span class="eyebrow">SPAM PROTECTION</span><div id="turnstile-widget"></div><p id="challenge-status" role="status">${available?'Loading the verification challenge…':'Verification will be available when online sending is enabled.'}</p><button type="button" class="text-button" id="retry-challenge" hidden>Restart verification</button></div>
        <p id="submission-status" role="status" class="submission-status"></p>
        <button class="button button-dark" id="send-submission" type="submit" ${available?'':'disabled'}>${story?'Submit for editorial review':'Send message'}</button>
        <p class="form-fine-print">Protected by Cloudflare Turnstile. <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">Privacy</a> · <a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noopener noreferrer">Terms</a></p>
      </form>
    </div>
  </section>`;
}

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
      message.textContent=receipt.message;
      const review=document.createElement('p'); review.textContent='It has not been published.';
      result.replaceChildren(heading,message,review);
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
