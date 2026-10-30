# Public social follow links and article share bar

The public site footer links to the Church Times Nigeria social pages and every article page carries a plain-link share bar (Facebook, X, WhatsApp, Telegram, LinkedIn, Email, Copy link, native share where supported). Account URLs live in one module, `src/lib/social-links.js`, and are also emitted as Organization `sameAs` in the article JSON-LD; no third-party scripts load and nothing is tracked.

Facebook now points to facebook.com/ChurchTimesNg, the page linked from the current churchtimesnigeria.net site; the other handles match that site.
