# Original prototype implementation and launch brief

**Historical document:** superseded for the current website by [the current-content rebuild](content-and-publication.md). The statements below describe the earlier concept version.

5 October 2026 · Design prototype and company operating proposal.

## Current deliverables

The Vite website runs without credentials or external services. It has journal, about, brand, partnerships, archive and contact views, topic filters, sample-story search, story dialogs, a local enquiry download, a non-submitting newsletter preview, source-linked current articles, public contact links, guide downloads and a financial model. All imagery is original local illustration/CSS artwork. No current-site source files, DNS or production settings were changed.

The research report audits public .net and UK pages and explains unresolved .com/.org access. The brand guide specifies position, voice, identity, colour, typography, editorial standards, social formats and governance. The financial plan separates revenue from collections, prices from hypotheses, and sponsorship from editorial influence. The operating workbook supplies reusable formula-backed planning and records templates.

## Validation and limits

Verified in this cloud machine: repeatable `npm ci` installation, successful production build, and **12 passing browser tests** across desktop and mobile. The final production smoke checks all six routes and all four guide/workbook/asset downloads. Screenshots are saved in `docs/previews/`. A pre-existing matching dev server was reused after its identity was inspected when a duplicate startup encountered the occupied port. Workbook checks verify the cached baseline surplus (₦85,000), break-even membership (163), print cash cost (₦2.3m), revenue target (₦2.875m), formula presence and the default unfunded cash shortfall. These are document-integrity checks, not verification of company finances.

The prototype has no database or production content pipeline. Hash routes serve design views, not separately indexed newsroom pages. Six feature concepts are original sample material with disclosed status. Current-publication links open the existing site; no article archive was copied into the new website.

A production release still needs a CMS integration, rights-cleared real articles, named authors/editors, proper article URLs and metadata, verified company identity, maintained trust/privacy pages, monitored form delivery and backups. Newsletter membership, billing and payment services are separate integrations; no payment is taken now.

## Recommended production architecture

Existing public markup indicates WordPress/Soledad/Elementor. The default recommendation is a staged managed-WordPress redesign using the approved visual system and preserving article slugs, with an accountable maintenance owner. It is a proposal, not a decision already taken or proof of backend versions.

Choose a lightweight editorial theme with reusable article, author, section, sponsor and archive templates. Use structured author/content fields, controlled roles, a tested backup service and editorial review workflow. Configure one SEO/metadata owner. Prefer provider-supported email signup and hosted payment flows over a custom card-processing system. Keys remain server-side; verify payment webhooks before granting access.

A headless deployment should be considered only if the team can support two systems, caching, previews and integrations and if it solves a demonstrated need. The prototype should guide the visual build; it is not a substitute for migration planning.

## Content and operating model

Required content fields: headline, summary, body, author, type (news/analysis/opinion/sponsored), section/tags, published/updated date, source links, image/credit/rights/alt text, correction history, canonical and sponsor disclosure if relevant. Preserve archive dates; do not replace historical dates with migration time.

Initial staffing: named editorial lead, commercial owner, digital producer and bookkeeping responsibility. These may be part-time or overlapping, but commercial approval must not control independent news coverage. Each publishing and sales workflow needs a responsible owner and replacement/recovery plan.

## Company inputs needed

1. Confirm the intended .net site and the registered/canonical domains; demonstrate control before migration.
2. Identify the current website manager, CMS/hosting access owners, backups, licences and renewal dates.
3. Confirm legal publisher, founder attribution, company contacts, monitored mailbox and official social handles.
4. Inventory the contact list: purpose, permission, opt-outs, paying readers and eligible newsletter subscribers separately.
5. Provide current costs, bank runway and obligations to authorised financial staff; validate pricing and tax treatment.
6. Select newsletter/payment providers, sign-off owners and a realistic editorial cadence.
7. Clear archive rights and inventory physical editions before scanning or charging for access.

Never enter credentials in chat or the repository. Secure settings should hold any later service keys.

## Cutover checklist

- Create and restore-test database/media backups.
- Export content and old URLs; audit duplicates, authors, media rights and sensitive data.
- Build on staging; map redirects and verify representative legacy articles.
- Approve visual identity, editorial trust pages and legal/privacy/consumer terms.
- Test contact delivery, newsletter confirmation and unsubscribe; payment/cancellation/refunds where applicable.
- Verify keyboard navigation, mobile reading, contrast, focus, performance and image licences.
- Validate article metadata, canonical URLs, sitemap coverage, RSS and share cards.
- Train editors and commercial staff, set monitoring and named support response.
- Obtain authorised production cutover approval, then deploy with rollback and monitor.

This task does not perform a production cutover. The current publication remains the operational source until migration is separately approved and verified.
