import {FIELD_LIMITS,STORY_CATEGORIES,submissionEndpoint} from '../lib/public-submissions.js';
export const publicFormConfig = kind => ({
  endpoint: submissionEndpoint({ kind, cmsUrl:import.meta.env.VITE_PUBLIC_CMS_URL,
    storyUrl:import.meta.env.VITE_PUBLIC_SUBMISSIONS_URL, contactUrl:import.meta.env.VITE_PUBLIC_CONTACT_URL }),
  siteKey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
  action: import.meta.env.VITE_TURNSTILE_ACTION || (kind === 'story' ? 'submit-story' : 'submit-contact'),
});
const textField = (name, label, type='text', autocomplete='off') => `<div class="public-field"><label for="public-${name}">${label} <span>(required)</span></label><input id="public-${name}" name="${name}" type="${type}" autocomplete="${autocomplete}" maxlength="${FIELD_LIMITS[name]}" required aria-describedby="error-${name}"><p class="field-error" id="error-${name}" hidden></p></div>`;

export function publicFormMarkup(kind='story') {
  const story = kind === 'story';
  const available = publicFormConfig(kind).endpoint && publicFormConfig(kind).siteKey;
  return `<section class="container public-form-section" aria-labelledby="public-form-title">
    <aside class="public-form-aside"><span class="eyebrow clay">${story?'SHARE A STORY':'WRITE TO THE NEWSROOM'}</span><h2 id="public-form-title">${story?'Help us follow the story.':'Let’s start a conversation.'}</h2><p>${story?'Tell us what happened, where it happened and why it matters. Include source links in your text where possible.':'Ask a question, suggest a correction or send an enquiry. For a correction, include the article link.'}</p><div class="form-review-note"><strong>Every public submission requires editorial review.</strong><p>Nothing you send here is published automatically. The newsroom may contact you for more information.</p></div><p class="small">Your details are sent only when you submit. This form does not save drafts in browser storage. Cloudflare Turnstile loads only when online sending is configured and you allow spam protection.</p><a class="text-link" href="mailto:info@churchtimesnigeria.net">Email the newsroom instead</a></aside>
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
        <div class="form-verification" id="public-verification" tabindex="-1" role="group" aria-label="Spam protection" aria-describedby="challenge-status"><span class="eyebrow">SPAM PROTECTION</span><p>Cloudflare Turnstile helps prevent spam. It loads only with your permission; you can withdraw permission in Privacy &amp; reading list.</p><button type="button" class="text-button" id="allow-submission-verification" disabled ${available?'':'hidden'}>Allow spam protection</button><div id="turnstile-widget"></div><p id="challenge-status" role="status">${available?'Allow spam protection before loading the verification challenge.':'Verification will be available when online sending is enabled.'}</p><button type="button" class="text-button" id="retry-challenge" hidden>Restart verification</button></div>
        <p id="submission-status" role="status" class="submission-status"></p>
        <button class="button button-dark" id="send-submission" type="submit" ${available?'':'disabled'}>${story?'Submit for editorial review':'Send message'}</button>
        <p class="form-fine-print">Protected by Cloudflare Turnstile. <a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noopener noreferrer">Privacy</a> · <a href="https://www.cloudflare.com/website-terms/" target="_blank" rel="noopener noreferrer">Terms</a></p>
      </form>
    </div>
  </section>`;
}
