# Church Times Nigeria: research, audit and recommendations

Working report · 5 October 2026 · Evidence: supplied founder interview and public page retrievals.

## Executive finding

Church Times Nigeria already has a functioning public news website at **https://churchtimesnigeria.net/**. It publishes beyond church events: the retrieved homepage has business and education/health sections, and the sampled business report covers customs brokerage and trade facilitation. The founder's ambition is therefore a direction to deepen, not an entirely absent subject area.

The strongest immediate commercial improvements are a dependable contact route, a current digital media kit, an opt-in newsletter and systematic sponsor follow-up. The premium redesign should improve reading and trust while preserving the current publication's content and search history. A visual rebrand alone will not repair collections, owner dependency or newsroom capacity.

The **UK Church Times is a distinct benchmark**, not evidence of affiliation. Its own site confirms an 1863 founding date and offers a mature portfolio of subscription, archive, advertising, recruitment and event products. Borrow the product mechanisms, not the identity, traffic claims or UK prices.

The requested .com and .org identities could not be resolved reliably. They remain outside this completed page audit; no ownership or redirect relationship to the Nigerian .net domain is asserted.

## 1. Method and scope

Retrieved public HTML and extracted visible text, navigation, metadata and asset references. Checked the Nigerian homepage, contact, advertising and two article pages, plus robots and sitemap index; checked the UK homepage, about, subscription, advertising, archive and contact pages. Research was read-only: no forms submitted, no logins, no private records, no bulk personal data collection and no changes to the current site.

Initial proxy denials were followed by successful retrievals for Nigerian .net and UK .co.uk. Some Nigerian internal pages initially timed out; reducing concurrency and increasing the read timeout yielded HTTP 200. The environment draft includes the research domains; a draft save alone is not proof of runtime access.

A separate Chromium attempt to render the live Nigerian homepage hit `ERR_CERT_AUTHORITY_INVALID` in this environment. Verification was not disabled. Python page retrievals succeeded through their supported trust configuration. Consequently, observations below about content and markup are verified; a full rendered visual, mobile, performance and accessibility audit of the existing sites is still pending. That browser error is not evidence that the site's TLS fails for ordinary readers.

Two retrieved articles are a diagnostic sample, not a statistical editorial-quality study. No traffic analytics, user research, financial accounts or administrator access were supplied.

## 2. Domain register

| Address | Observation | Confidence / boundary |
|---|---|---|
| https://churchtimesnigeria.net/ | HTTP 200; Church Times Nigeria masthead/content; canonical points to the .net homepage. | Verified public publication. Company control and preferred canonical domain still need confirmation. |
| https://churchtimesnigeria.com/ and https://www.churchtimesnigeria.com/ | HTTPS proxy tunnel rejected; HTTP candidate returned 403. | Cannot assess ownership, availability or redirects. |
| https://churchtimesnigeria.org/ and https://www.churchtimesnigeria.org/ | HTTPS proxy tunnel rejected; HTTP candidate returned 403. | Cannot assess ownership, availability or redirects. |
| https://churchtimes.com/ | Apex request rejected by proxy; www variant returned 404. | Do not identify it as Nigeria or UK based on a matching name. |
| https://churchtimes.org/ | Apex request rejected by proxy; www variant returned 404. | Domain relationship unresolved; a www 404 does not establish an empty apex site. |
| https://churchtimes.net/ | Proxy tunnel rejected. | Literal .net candidate not assessed. |
| https://www.churchtimes.co.uk/ | HTTP 200; UK publication and product pages retrieved. | Verified separate comparison site; no affiliation claimed. |

The user was asked which .net URL was intended. The Nigerian .net content strongly matches the supplied interview, but domain preference and ownership must still be decided by the company. Do not move domains until control, backups and URL redirects are tested.

## 3. Nigerian site findings

Sources: [homepage](https://churchtimesnigeria.net/), [contact](https://churchtimesnigeria.net/contact-us/), [advertising](https://churchtimesnigeria.net/advert/), [news sample](https://churchtimesnigeria.net/sowore-holds-private-meeting-with-pastor-adeboye-recounts-his-encounter/), [business sample](https://churchtimesnigeria.net/anlca-72-stakeholders-seek-digital-transformation-and-better-trade-facilitation/), [robots](https://churchtimesnigeria.net/robots.txt), [sitemap](https://churchtimesnigeria.net/sitemap_index.xml). All observed 5 October 2026.

| Priority | Observed evidence | Business/editorial implication | Recommended action |
|---|---|---|---|
| Immediate | Contact page explicitly says **“Error: Contact form not found.”** | A documented broken route for leads and reader communication. Mail delivery was not tested. | Repair the live form or provide verified monitored email and telephone fallback. Test delivery, consent, spam handling and response ownership. |
| Immediate | Homepage links include `facebook.com/PenciDesign` and `twitter.com/PenciDesign`. | Some social destinations lead to the theme vendor; these are not evidence of official Church Times accounts. | Inventory all responsive menus/footer/social widgets; replace with verified company handles. Test every destination. |
| Immediate | Homepage has duplicated Open Graph blocks; one `og:url` is `/`, another the full canonical; `og:image` points to an Ayoola Foods advert. Descriptions mention earlier lead stories, while the visible lead list is different. | Shared links can misrepresent the publication or show paid creative instead of editorial identity. Actual social-platform rendering was not tested. | Use one metadata owner, canonical absolute URL, current editorial description and publisher-branded share image. Test with platform validators. |
| High | Advertising page offers print units, colour full page **₦435,000**, half page **₦260,625**, quarter page **₦140,500**, and inserts. It displays **“Vat (5%)”** and film/camera-ready technical language. | Public commercial information is print-oriented and undated in the extracted body; no digital newsletter sponsorship package appeared in that page. Do not assume these are current approved rates or current applicable tax treatment. | Issue a dated, costed media kit for digital and print. Accountant verifies tax treatment; sales owner confirms rates and terms. Keep legacy print quotes separate from new digital pilots. |
| High | Both sample articles show a generic “Church Times” author; business body separately says **“By Derin Adeogun.”** | Inconsistent byline presentation can obscure reporting responsibility. | Separate contributor byline from publisher identity; add bios, dates, source links and correction history. |
| High | Retrieved author biography states a mission to cover politics, business, education, health and other spheres. Homepage includes Business and Education & Health. | Broader economic coverage already exists. | Deepen the founder's vision through regular beat reporting rather than suggesting the site has never covered other sectors. |
| High | Contact page publishes **Churchtimes Agency Ltd**, an Ota, Ogun State address, and `info@churchtimesnigeria.net` plus a named email. Author bio uses “Church Times Agency.” | Public operational identity exists, but registered name, current ownership and responsible manager are not proven by page text. | Confirm legal registration, naming consistency, contact owner and domain/CMS administrator. |
| High | URLs and assets identify WordPress, Soledad theme, Elementor, Contact Form 7, Rank Math sitemap and W3 Total Cache output. Version query strings are visible but not a verified installation inventory. | A migration should accommodate WordPress content and existing slugs. | Prefer a staged WordPress theme/content migration unless a clear operating case supports headless infrastructure. Audit licences, plug-ins, backups and roles with authorised access. No vulnerability finding is made from version strings. |
| Medium | Sitemap index has post, page, category, news and video sitemaps; index lastmod values shown are in March/April 2025, while sampled articles display October 2026 dates. | Discovery may need review; index timestamps alone do not prove articles are omitted. | Inspect child sitemaps and update cache/index generation; compare coverage against the actual URL inventory. |
| Medium | Homepage pagination points to page 1,082. | Substantial potential content history; pagination is not an article count or proof of quality. | Inventory all content from an authorised export before redesign. Preserve each retained article slug and historical context. |
| Medium | Visible homepage content includes a video URL and Ayoola advertising placements; body/footer contain 2021 and 2023 copyright strings. | Existing inventory could support sales, while stale presentation deserves cleanup. | Audit placements, rights, labels and mobile behaviour; use consistent publisher identity and maintained dates. |

### Article sample assessment

**News sample:** “Sowore holds private meeting with Pastor Adeboye, recounts his encounter,” dated 4 October 2026 on the page. The report attributes its central account to Sowore's social-media post and includes online responses. That attribution is observable; the underlying meeting and quotations were not independently checked in this task. Recommendation: link the original statement and distinguish the speaker's account from facts independently verified by the newsroom.

**Business sample:** “ANLCA @ 72: Stakeholders Seek Digital Transformation and Better Trade Facilitation,” dated 4 October 2026 on the page; body byline Derin Adeogun. It discusses trade facilitation, port delays, technology and remarks from several stakeholders. This directly supports a wider-economy editorial direction. The task did not independently verify every quotation, attendance claim or event detail. Recommendation: maintain source records and a clear reporter byline; supplement event reports with explanatory and accountability coverage.

Do not generalise two articles into a conclusion that all coverage is strong or weak. A subsequent 20-article review should use a declared sample and score sourcing, fairness, corrections and distinction between news/opinion/paid content.

## 4. UK benchmark: observed mechanisms

Sources: [about](https://www.churchtimes.co.uk/about-us), [subscriptions](https://www.churchtimes.co.uk/subscribe), [advertising](https://www.churchtimes.co.uk/advertise), [archive](https://www.churchtimes.co.uk/archive), [contact/team](https://www.churchtimes.co.uk/contact-us), [homepage](https://www.churchtimes.co.uk/). All observed 5 October 2026; offers and prices can change.

| Mechanism | Verified public-page observation | Nigerian adaptation |
|---|---|---|
| Explicit independence | About page says founded **1863**, owned by Hymns Ancient & Modern since **1989**, independent of Church of England hierarchy; includes an IPSO complaints route. | Publish ownership, editorial charter and a locally appropriate complaints/corrections process. Do not claim IPSO membership for Nigeria. |
| Subscription tiers | Print, print + digital and digital options; introductory 10 issues for £10 and digital £10 for two months shown; institutional/gift options and training access. | Test a clear reader-support offer first. Consider institutional memberships only after demand and fulfilment are proven. Do not convert UK price points into naira recommendations. |
| Limited free access | Public welcome copy describes up to four free articles per month and account/newsletter registration. | A conversion funnel is a useful model; a paywall is not an immediate requirement without an engaged audience and worthwhile benefits. |
| Archive value | Archive described as 1863 to present; full access included for print + digital/digital subscribers; thumbnails available to others through UKPressOnline. | Inventory and digitise a five-edition Nigerian pilot. Offer access only after rights, quality and demand checks. No archive was supplied for this build. |
| Structured advertising | Rate card includes print display, classified/recruitment, inserts, website and newsletter advertising, specifications, deadlines and terms. | Sell explicit deliverables with realistic production limits and advance payment. Use a current digital kit and measured local audience. |
| Newsletter inventory | Advert page claims **over 19,000 recipients**, **60% average open rate**, weekday sends and **£444 for eight MPU appearances**. These are publisher claims, not independently audited measurements in this task. | Build an opt-in weekly letter and track delivered recipients/clicks; publish only verified Nigerian numbers. Open rates alone are unreliable engagement evidence. |
| Audience claims | Advert page claims weekly distribution of 16,000 and more than 2m annual unique web visitors. | Do not import these figures into Church Times Nigeria's media kit or prototype. |
| Recruitment / events | Navigation and homepage contain jobs and events, including ticket links; advertising terms describe recruitment packages. | Potential later-stage products, contingent on buyer demand and delivery capacity. Excluded from baseline revenue. |
| Named responsibilities | Contact page separates editorial, features/books, advertising, subscriptions and digital roles. | Appoint accountable editor, digital producer, commercial lead and bookkeeper even if part-time. |

The lesson is a connected product portfolio and clear responsibility, not maximal complexity. Nigeria should start with what it can publish and sell dependably.

## 5. Founder interview: evidence and verification

| Supplied recollection | Use now | Verification needed |
|---|---|---|
| 13 years at The Punch; launch April 2007 after March resignation; ₦10,000 starting funds | Attributed founding story in prototype | Founder identity and approval, dates, first masthead/issue |
| Reporting with secular journalism standards; Christians across the economy | Editorial foundation, also broadly aligned with current-site author bio | Approved editorial charter and accountable practices |
| Early advertising support from FIDSON, Laterna, Ayoola Foods, Stanbic, Zenith and Femi Adesina | Private prospect/history review only | Exact roles, dates, legal names and permission; not current partner claims |
| Quarterly print, COVID online transition, Anglican special edition | Operating history hypothesis | Edition records, costs, distribution and digital transition dates |
| Approximately ₦2m cost per edition | Provisional cost gate in financial model | Date, print run, cost inclusions and fresh quotes |
| Hardcopies 2007–2019 | Proposed archive opportunity | Inventory, copyright, contributor permissions and sensitive data |
| Dormant Facebook/Instagram/X | Recovery and account-ownership task | Actual handles, administrator access and analytics |

## 6. Original prototype recommendation and migration

The visual prototype described in this section was subsequently replaced by the real-content photographic rebuild documented in [content-and-publication.md](content-and-publication.md). The audit findings remain the source of migration recommendations.

The implemented prototype proposes forest green, parchment surfaces, editorial serif headlines, restrained interface typography, original illustrations, readable hierarchy and clear Nigerian identity. Its six feature concepts are labelled sample material, not fabricated journalism. Current-publication article links are separate source references, not a migrated archive.

Production information architecture: journal/home → sections → articles → authors → search → archive → about/editorial standards → advertise/partnerships → contact → privacy/corrections. Newsletter and membership should be connected only once providers, consent, pricing and support are approved.

Suggested production route: review the visual system with the founder/editor, then implement it on staged managed WordPress with a tested editorial theme and preserved slugs. Existing WordPress evidence makes this an economical default; a new headless stack requires a specific business case and ongoing technical owner. This repository is a Vite design prototype, not a WordPress migration or deployed newsroom CMS.

Migration sequence: verify access/ownership → full database and media backup → staging clone and inventory → rights/byline/taxonomy cleanup → theme integration → old-to-new URL mapping → editorial/user acceptance → real form/email/payment tests as applicable → backup restore drill → authorised production cutover → monitor errors and redirects. Never scrape-and-republish all history as a substitute for an authorised export and rights audit.

Launch gates: legal identity and canonical domain confirmed; editor approves real stories; current manager participates in handover; forms deliver to a named monitored owner; consent/unsubscribe work; no vendor social links; correct metadata; redirects verified; backups restore; mobile/keyboard checks pass; commercial terms and taxes confirmed; privacy policy approved.

## 7. Answering the three founder-interview questions

**Do we have a contact list?** Unknown. Public contact details and historical relationships do not establish an opt-in audience or transferable CRM. Inventory business contacts separately from newsletter consent and existing paying customers.

**Are we ready to go online?** The public .net publication is already online and shows recent article dates. Readiness for the new digital product depends on editing capacity, consented distribution, ownership, working forms, backups and commercial operations, not only the visual build.

**Who is the current website manager?** Not identified by the reviewed public pages or interview. The contact page supplies company contact details but does not establish CMS/hosting responsibility. Confirm the manager, admin ownership, recovery process and support agreement with the founder.

## 8. Remaining gaps

- .com/.org domain ownership, redirects and intended role; preferred canonical address.
- Rendered existing-site mobile/desktop, accessibility and performance audit; no numerical scores are claimed.
- A wider editorial sample, independent verification of founder history and site-reported events.
- Real audience analytics, mailing-list consent, social handles and administrative ownership.
- Actual financial accounts, current costs, available cash, tax advice and paid willingness-to-buy tests.
- Production CMS migration, scanned archive, newsletter delivery, payment handling and deployment.

Completed evidence supports the prototype, brand direction and operating hypotheses. It does not justify claiming the redesign is deployed, the company is profitable, the .com/.org sites were fully audited or a paid audience exists.
