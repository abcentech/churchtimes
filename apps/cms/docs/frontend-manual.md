# Church Times Nigeria: Public Website (Front-End) Manual

For the owner, editors and the newsroom team. You do not need to be technical. Each new word is explained the first time it appears, and there is a glossary at the end (section 22).

This manual covers **what readers see on the public website** and **every setting that controls it**. It does not repeat how to write, review and publish stories. For that, read the [Staff Manual](staff-manual.md) (links to it appear where they help).

**How this manual was made.** Every picture was taken from a practice copy of the real system (the "local demo", see section 1) with invented people and stories, using a desktop browser (1280 pixels wide) and a phone-sized browser (390 pixels wide). Every statement was checked against the program code on the branch `agent/wave12-integration` or against the running practice copy. Things we could not check are listed in section 24 (**Not verified**), and things that look like faults are listed in section 25.

**Practice names.** "Demo Reporter", "Ada Okafor" and stories such as "Demo analysis: how a northern parish rebuilt after the attack" are invented for training. Your real site shows your own names.

**Off by default.** Some features only exist when an administrator switches them on. Wherever that is true this manual says **off by default** and tells you which switch turns it on. The big table in section 20 collects every switch in one place.

## Contents

1. What the public site is, and where its stories come from
2. The home page
3. The article page
4. Author pages
5. Topic pages and the Follow button
6. Trust pages: editorial standards, ownership, corrections
7. Search
8. Display settings (dark, high contrast, text size)
9. Reading progress, reading list and printing
10. Data saver
11. Offline reading, saved stories and the install prompt
12. Page transitions and the speed features, explained plainly
13. The Give page and the thank-you page
14. Newsletter: sign-up, confirm, unsubscribe
15. WhatsApp prompt, social links and sharing
16. Church calendar and verse of the day
17. Live coverage
18. Privacy and consent: what is stored and when
19. Accessibility and keyboard use
20. What controls what (settings table)
21. What readers see in each state (loading, empty, offline, error)
22. Troubleshooting
23. Glossary
24. Not verified
25. Things that look like faults (for the developers)

---

## 1. What the public site is, and where its stories come from

The public site is the part of Church Times Nigeria that readers open at `https://www.<your-domain>`. It is a **single-page site**: after the first page loads, most moves between pages happen inside the browser without a full reload, but every story also has its own normal web address (for example `/diocesan-choir-festival-fills-ibadan-cathedral-grounds/`) that works when typed or shared.

There are **two sources of stories**. This matters because staff control one of them and not the other.

| Source | What it is | Where readers see it | Who controls it |
| --- | --- | --- | --- |
| **The CMS newsroom** | Every story staff write and publish in the [newsroom app](staff-manual.md). A **CMS** (content management system) is the back office that stores all stories. | "From the newsroom" strip on the home page, the **Latest** page, search results, topic pages, author pages, the "Following" feed, and every story page. | Editors, through publishing. |
| **The bundled edition** | A fixed set of 21 stories (dated up to 5 October 2026) that is built into the website program itself. | The big lead story, "In the headlines", "Latest news" cards, "Ideas & public life", and the section pages (News, Features, Interviews, Business, Health & education, Opinion, Publisher's note). | Developers only. Editors cannot change it from the CMS. |

> **Important for editors.** Publishing a story makes it appear in the "From the newsroom" strip (the three newest), the **Latest** page, search and the other places above. It does **not** put it into the big lead slot, and it does **not** add it to the section pages. Those parts are fixed in the website code (see section 25, item 2). The lead story is one chosen story of the bundled edition.

**Web addresses readers can use**

| Address | What it shows |
| --- | --- |
| `/` | Home page |
| `/<story-slug>/` | One story (default shape; see "Article address" in section 20) |
| `/latest/` | Latest newsroom reports, with a section filter |
| `/author/<slug>/` | An author page |
| `/topic/` and `/topic/<slug>/` | Topic list and one topic |
| `/about/editorial-standards/`, `/about/ownership/`, `/corrections/` | Trust pages |
| `/give/` and `/give/thanks/` | Give page and thank-you page |
| `/church-calendar/` | Church calendar |
| `/newsletter/confirm/` and `/newsletter/unsubscribe/` | Opened from links in newsletter emails |
| `/#live` | Live coverage |
| `/#saved` | Reading list |

![The top of the home page on a computer.](frontend-manual/img/01-home-desktop.png)

### Trying it on your own computer (practice copy)

> **Practice box.** Ask your technical helper to follow `apps/cms/docs/local-demo.md` (in short: `npm run demo` in the `apps\cms` folder). It prints the web addresses and keeps the passwords in a private file that is never shown on screen. The practice copy has about 320 invented stories plus the sample stories used in this manual.
>
> The plain practice copy has the **newsletter box, the Give page, archived comments and the contact form switched off**, because the website is built without their addresses (section 20). To take the pictures for sections 13, 14 and the comment section, the practice site was rebuilt with those addresses added and a **pretend payment provider** was used instead of Paystack. Pictures of those parts therefore show the real screens, but with test data.

**For developers.** The public site is the Vite app in the repository root (`src/main.js`), served by `tools/serve-public.mjs` (the "public host"), which also renders story, author, topic, trust, give and calendar pages on the server so they read without JavaScript. The bundled edition is `src/data/stories.json`; `selectHomepage()` in `src/lib/homepage.js` pins the lead to story id 29259.

---

## 2. The home page

**What it does.** It is the front door: the latest stories, a few reasons to stay (verse of the day, WhatsApp group, newsletter) and links to everything else.

**What a reader sees, top to bottom.**

1. **Utility bar** (dark strip): the line "INDEPENDENT JOURNALISM. A CHRISTIAN PERSPECTIVE." and the links **Latest news**, **About us**, **Advertise**, **Contact**.
2. **Masthead:** the Church Times Nigeria name, a **Stay connected** button (it scrolls to the connect band at the bottom) and the line "Reporting with purpose since 2007".
3. **Menu bar:** a home icon, **Latest**, **Live coverage**, **News**, **Features**, **Interviews**, **Business**, **Health & education**, **Opinion**, **Publisher's note**, and at the right three icon buttons: the **bookmark** (reading list, with a number when something is saved), the **half-moon** (Display settings, section 8) and the **magnifying glass** (search, section 7). On a phone the menu collapses into a button that opens the "Explore Church Times." window.
4. **Lead and "In the headlines".** The large lead story, and three smaller stories beside it.
5. **Latest news.** A grid of story cards with filter buttons **All**, **News**, **Business**, **Features**, **Opinion**, **Interviews**, and a **More stories** button that adds six cards at a time. When there is nothing more it says "You're up to date with this selection."
6. **Ideas & public life.** Three opinion, column or Publisher's note stories.
7. **From the newsroom.** The three newest published CMS stories (a small "just published" strip). It only shows stories not already shown above.
8. **Following** (only for readers who follow something; section 5).
9. **Verse of the day** (section 16).
10. **Join our WhatsApp group** prompt (section 15).
11. **Connect band** (dark green): "Good stories deserve your attention." This is where the **newsletter sign-up** lives when it is switched on. When it is **off** (the normal state of the plain practice copy), the band shows a **Request updates** button that opens an email to the newsroom instead, with the note "You are not automatically subscribed."
12. **Footer:** the name, a **Follow us** row of social icons, link columns, the **Corrections** link, the **Privacy & reading list** button and the **Data saver** button.

![The whole home page, top to bottom, in the plain practice copy.](frontend-manual/img/01b-home-full.png)

![The home page on a phone.](frontend-manual/img/02-home-mobile.png)

![The connect band as it appears when the newsletter box is off: a Request updates button.](frontend-manual/img/03-connect-band-default.png)

![The footer: social icons, link columns, Privacy & reading list and Data saver.](frontend-manual/img/04-footer.png)

**How staff control it.**

- To get a story into "From the newsroom", **publish** it (the three newest published stories appear).
- The lead, "In the headlines", "Latest news" and "Ideas & public life" come from the bundled edition. A developer must change the edition and rebuild the site.
- The newsletter box appears only when the site was built with the newsletter address and the spam-protection key (section 14).
- The **Following** row, **Verse of the day** and **WhatsApp** prompt have no staff switch.

*Good to know.* The date in the masthead ("Monday, 5 October 2026") and the footer line "Selected coverage · updated 5 October 2026" are fixed text. They do not follow today's date (section 25, item 1).

---

## 3. The article page

**What it does.** It shows one published story with everything that tells the reader what kind of story it is and whether to trust it.

**Walk-through.** Open any story, for example `/demo-w12-parish-rebuilt/`.

1. **Content-type label** (a small boxed word) before the section name: **News**, **Analysis**, **Opinion**, **Sponsored**, **Explainer** or **Fact-check**. Staff choose it with **Content type** on the story. Use **Sponsored** for anything paid for.
2. **Disclosure line.** **Opinion** stories show "Opinion: the views expressed are the writer's own." **Sponsored** stories show "Sponsored content: paid for by a commercial partner." under the summary. Other types show none.
3. **Kicker.** An optional short line above the headline (up to 60 characters), for example "Rebuilding Together".
4. **Headline** and **summary** (the "deck").
5. **Byline.** "By Ada Okafor". The name is a **link to the author page** when the story has a **Byline author** whose profile is **Is Public**. Otherwise it is plain text taken from the byline name.
6. **Dates.** The publication date, then **Updated** with a date, then the **reading time**.
   - The **Updated** stamp appears **only** when an editor filled **Last substantive update** on the story **and** that date is later than the publication date. It is never added automatically. Use it only when the story changed in substance.
   - The reading time is the number of words in the story divided by 220 and rounded, never less than "1 min read". Pull quotes and gallery captions are not counted.
7. **Share button** (three connected dots) and a **Listen** button that reads the story aloud using the reader's own device voice. **Listen** only appears in browsers that can speak text.
8. **Photo** with caption and credit.
9. **What you need to know.** A shaded box of up to five short key points.
10. **Story text.** It may contain a **pull quote** (a big quotation set apart, with who said it), a **gallery** (up to 12 photos with captions and credits), audio, video and tables.
11. **Share this story** bar (section 15).
12. **Corrections & updates.** If staff added a correction note, it appears here with its date.
13. **Original publication** link for recovered old stories.
14. **Archived comments** for old stories that have them (section 21 shows the wording; off by default).
15. **Support our journalism** ask (only when giving is on, section 13).
16. **Join our WhatsApp group** prompt, the newsletter box when switched on (section 14), and **More from the newsroom**.

![The top of a story: label, kicker, headline, byline link, dates and reading time.](frontend-manual/img/10-article-analysis-top.png)

![A whole story page from top to bottom (scaled down).](frontend-manual/img/11-article-full.png)

![The same story on a phone.](frontend-manual/img/11b-article-mobile.png)

![The key points box.](frontend-manual/img/12-keypoints.png)

![A pull quote with its attribution.](frontend-manual/img/13-pullquote.png)

![A gallery of three photos with captions and credits (the demo photos are plain colour blocks).](frontend-manual/img/13b-gallery.png)

![A Sponsored story shows its label and the paid-content disclosure.](frontend-manual/img/14-article-sponsored-top.png)

![An Opinion story shows its label and "the views expressed are the writer's own".](frontend-manual/img/15-article-opinion-top.png)

![A Fact-check story.](frontend-manual/img/16-article-factcheck-top.png)

![The corrections note under a story.](frontend-manual/img/18-corrections-on-article.png)

**Scripture hover cards.** When a story names a Bible passage such as "John 3:16" or "Psalm 23:1-3", the reference is underlined with dots. A reader can hover over it, tab to it and press Enter, or tap it. A small card opens with the verse text and "KJV" (King James Version, public domain, built into the site, so it works offline). The card closes with **Esc**, the **×** button or by clicking elsewhere. Unknown or impossible references (for example "John 99:1") stay plain text. Cards are not printed. There is **no staff switch**; it works on every CMS story.

![Hovering over "John 3:16" opens a card with the King James text.](frontend-manual/img/100-scripture-card.png)

**Related stories.** Stories from the CMS end with **More from the newsroom** (a link to the Latest page). The "More to consider" row of related cards appears only on pages of the bundled edition, not on CMS stories (section 25, item 4).

**How staff control it.** All of the labels above are filled in on the story in the CMS admin, in the story's sidebar and body. In the practice copy:

![The story's sidebar in the CMS admin: Content Type, Last Substantive Update, Topics and Byline Author, with Kicker and Key Points beside them.](frontend-manual/img/117-admin-article-keypoints.png)

| Reader sees | Staff field (CMS admin, story) | Limits |
| --- | --- | --- |
| Content-type label | **Content type** | News is the default |
| Kicker | **Kicker** | 60 characters |
| Byline link | **Byline author** | Only public profiles are shown |
| Updated stamp | **Last substantive update** | Must be later than publication |
| What you need to know | **Key points** | Up to 5 points, 200 characters each |
| Pull quote, gallery | Blocks in the story body | Gallery: up to 12 photos |
| Corrections & updates | **Corrections** (note and date) | |

**For developers.** Rendering is shared between the server and the browser in `src/lib/reader-article.js` and `src/lib/reader-blocks.js`; scripture cards are in `src/features/growth/scripture/`.

---

## 4. Author pages

**What it does.** A public page for a writer, reached from the byline link.

**How a reader uses it.** Click the writer's name under a headline. The page shows the photo, **Author** label, name, a **Follow** button, role (for example "Senior Correspondent, Abuja"), a short bio, social links (X, Facebook, Instagram, LinkedIn, website), and the writer's latest 20 stories with **Newer** and **Older** buttons. Following a writer is explained in section 5.

![An author page on a computer.](frontend-manual/img/20-author-desktop.png)

![An author page on a phone.](frontend-manual/img/20b-author-mobile.png)

**A profile that is not public** answers "Author unavailable." The same happens when the address is typed wrongly.

![A hidden profile shows "Author unavailable."](frontend-manual/img/21-author-hidden-404.png)

**How staff control it.** In the CMS admin, **Newsroom > Author profiles**. Fill in name, role, bio (up to 600 characters), photo and links, then tick **Is Public**. The photo becomes public only while the profile is public. Until **Is Public** is ticked the profile is hidden everywhere, even on stories that point at it. See the [Staff Manual](staff-manual.md), "Author profiles and topics".

![Ada Okafor's profile in the CMS admin. "Is Public" is ticked at the right.](frontend-manual/img/114-admin-author-edit.png)

---

## 5. Topic pages and the Follow button

**What it does.** A **topic** groups stories: a subject ("Religious freedom"), a denomination ("Anglican Communion"), a series ("Rebuilding Together") or a ministry ("Youth ministry"). Readers can **follow** topics and writers; new stories from them then appear on the home page under **Following**.

**How a reader uses it.**

1. Open a topic page, for example `/topic/religious-freedom/`. It shows the kind of topic (TOPIC, DENOMINATION, SERIES or MINISTRY), name, description and the stories.
2. Press **Follow**. The button changes to **Following** and a short message says "You are following Religious freedom. New stories appear under "Following" on the home page." Press again to stop.
3. `/topic/` lists all public topics, each with its own Follow button.
4. Writers are followed the same way from their author page.
5. Back on the home page a **Following** section lists the newest stories from everything followed ("From the topics and writers you follow."). **Manage what you follow (n)** opens a list with an **Unfollow** button for each item.

![A topic page with its Follow button.](frontend-manual/img/22-topic-desktop.png)

![The topic list.](frontend-manual/img/23-topics-index.png)

![The home page "Following" section, after following one topic and one writer.](frontend-manual/img/61-following-feed.png)

*Where follows live.* Only in the reader's own browser (`ct-following`). There is no account and nothing is sent to the newsroom, so a reader who clears their browser data or switches phones starts again. Up to 50 follows are kept and the Following section shows stories for the 12 most recent.

*Offline.* The Following section keeps its last list and shows "You are offline. Showing the list saved <date>."

**How staff control it.** Topics: **Newsroom > Topics**; tick **Is Public**. A topic that is not public is never shown, also when a story carries it. A story can carry up to 10 topics (**Topics** in the story's sidebar).

*Not obvious.* Readers cannot find the topic list from the menu or footer, and a story page does not show its topics. Topic pages are reached by a direct link, which you can put in a story, a post or a newsletter (section 25, item 3).

---

## 6. Trust pages: editorial standards, ownership, corrections

**What it does.** These pages tell readers how the newsroom works, who owns it and how it fixes mistakes.

| Page | Address | Shown when |
| --- | --- | --- |
| Editorial standards | `/about/editorial-standards/` | Site trust is **published** and the standards text is not empty |
| Ownership and funding | `/about/ownership/` | Site trust is **published** and the ownership text is not empty |
| Corrections | `/corrections/` | Always (see below) |

- **Corrections page.** It always opens. It shows the corrections policy text (only when Site trust is published) and a **Corrections log**: every correction note added to a published story, newest first, with the story headline as a link and the correction date. The log is built automatically.
- Pages that are off answer "not available" and are left out of the footer links and the sitemap (the file search engines read).
- Each trust page links to the other trust pages ("Our standards") and ends with **Contact the editors** when that text is filled in.
- Trust pages print cleanly.

![Editorial standards.](frontend-manual/img/24-trust-editorial.png)

![Ownership and funding.](frontend-manual/img/25-trust-ownership.png)

![The corrections page and its log.](frontend-manual/img/26-corrections-log.png)

**How staff control it.** CMS admin, **Newsroom > Site trust pages** (editor-in-chief and admin only). Fill **Editorial standards**, **Ownership and funding**, **Ethics and corrections policy** and **Contact the editors**, then tick **published** (in the right-hand column). Untick **published** to take all of it down at once. Use headings, paragraphs, lists, quotes and links only; photos and embeds are refused.

![The Site trust pages screen in the CMS admin.](frontend-manual/img/110-admin-site-trust.png)

> **Before launch (owner / editor-in-chief).** Until Site trust is published, the two "about" pages answer "not available" and only **Corrections** is linked in the footer.

---

## 7. Search

**What it does.** Readers find stories by words in the headline, summary, writer or section.

**How a reader uses it.**

1. Click the magnifying glass. A window "What's on your mind?" opens with a search box, and the shortcuts **Faith**, **Business**, **Education**, **Gbenga Osinaike** under "START WITH A TOPIC".
2. **Suggestions.** After **three letters** and a short pause (about a third of a second) up to five matching stories appear under the box, each with its section and date, and the typed word **highlighted**. The last line is "Search all stories for "church"". Use **Up** and **Down** arrows to choose, **Enter** to open, **Esc** to close the list. It needs a connection; offline it says "You are offline, so suggestions are unavailable."
3. **Results page.** Press **Enter** or **Search**. The page "Results for "church"" first lists matching stories of the bundled edition, then **Published newsroom search** with the CMS results. Matching words are highlighted. Search finds beginnings of words, so "church" also marks "churches".
4. **Filters.** Above the newsroom results: **Section** (all published sections) and **Year** (from the current year back to 2008), plus **Clear filters**. A line announces "Showing results filtered by ...".
5. **Recent searches.** The next time the window opens, "RECENT SEARCHES" lists up to eight previous searches with **Clear recent searches**. They are kept only in this browser.

![The search window before typing.](frontend-manual/img/40-search-dialog-empty.png)

![Suggestions after typing "church": the matched word is highlighted.](frontend-manual/img/41-search-suggestions.png)

![The results page.](frontend-manual/img/42-search-results.png)

![Section and Year filters above the newsroom results.](frontend-manual/img/43-search-filters.png)

![Recent searches in the search window.](frontend-manual/img/44-search-recent.png)

**How staff control it.** There is no search setting. Search finds **published** stories only, so a story becomes findable when it is published and stops being findable when it is taken down. A reader's recent searches are theirs alone.

---

## 8. Display settings (dark, high contrast, text size)

**What it does.** Lets each reader make the site comfortable to read.

**How a reader uses it.**

1. Click the **half-moon** button in the menu bar (its name is "Display settings"). On a phone it is in the top bar next to search.
2. Choose a **Theme**: **Match device** (follows the phone or computer), **Light** or **Dark**.
3. Choose **Contrast**: **Match device**, **Standard** or **High** (stronger black on white, thicker lines).
4. Choose **Article text size**: five steps, **Smaller**, **Default**, **Large**, **Larger**, **Largest**. It enlarges the story text, summary and key points only; ads and forms keep their size.
5. The change happens at once. Close with **Esc** or the × button.

The window says "Saved on this device only. Text size applies to article pages."

![The Display settings window.](frontend-manual/img/50-display-settings.png)

![A story in the dark theme.](frontend-manual/img/52-dark-article.png)

![High contrast: black header strip and stronger lines.](frontend-manual/img/53-high-contrast.png)

![A story at the largest text size.](frontend-manual/img/54-text-largest.png)

![Display settings on a phone.](frontend-manual/img/97-mobile-display-settings.png)

*Saved where.* Only in the browser (`ct-theme`, `ct-contrast`, `ct-text`), and only when the reader changes a choice. The choices are applied before the page is drawn, so there is no flash of the wrong colours. With JavaScript off, a device set to dark still gets the dark theme; high contrast then needs the settings window (which needs JavaScript). No text on the site is smaller than 12 pixels.

**How staff control it.** No staff switch; it is always on.

---

## 9. Reading progress, reading list and printing

**Reading progress.** On story pages a thin red line runs along the top of the sticky menu bar and grows as the reader scrolls (visible at the top of the picture below). It is decoration only and is never read out by screen readers.

![A thin red progress line along the top, about a third of the way down a story.](frontend-manual/img/19-reading-progress.png)

**Reading list (bookmark).** Readers save stories to read later with the small bookmark on a story card. The bookmark in the menu bar shows how many are saved and opens `#saved` ("Your reading list: Worth returning to."), with **Clear reading list**. It is stored only in the browser (`ct-reading-list`).

![The reading list when nothing is saved: "A little room for good reading."](frontend-manual/img/29-saved-empty.png)

![A reading list with two saved stories.](frontend-manual/img/64-saved-list.png)

> **Limit.** The bookmark appears only on cards of the bundled edition (the home page grid, section pages and search results of the edition). It does not appear on newsroom (CMS) story cards or story pages (section 25, item 5). To keep a CMS story for offline use see section 11.

**Printing.** Printing a story, author page or trust page prints the headline, label, key points, text and corrections, hides the menu, ads, sharing and forms, and writes out link addresses.

**How staff control it.** No staff switch.

---

## 10. Data saver

**What it does.** Saves mobile data by not downloading photos until the reader asks. Useful where data is expensive.

**How a reader uses it.**

1. At the very bottom of any page press **Data saver** (next to **Privacy & reading list**). Its state is marked pressed.
2. Photos are replaced by empty grey boxes of the same size, so the page does not jump. A bar appears at the top of the content: "Data saver is on: images load when you ask." with a **Show images** button. Tapping one photo also loads just that photo.
3. In data saver mode: comments (when on) wait for a **Show comments** button, speed-up downloads in the background are switched off, the install banner is not offered, and the "Support our journalism" ask is not shown when the *browser's own* Save-Data setting is on.
4. Press **Data saver** again to turn it off.

If the reader never chooses, the site follows the browser's own "Lite mode / Save-Data" setting where the browser offers one (Chrome on Android).

![The home page with Data saver on: grey boxes and the "Show images" bar.](frontend-manual/img/71-data-saver-home.png)

*Saved where.* The choice is kept in the browser (`ct-lite`) and in a small cookie of the same name (one year) so that pages built on the server also respect it. It only says "on" or "off"; it identifies nobody.

**How staff control it.** No staff switch.

---

## 11. Offline reading, saved stories and the install prompt

**What it does.** The site can work without a connection. A small helper program in the browser, called a **service worker**, keeps copies of pages the reader has opened.

**How it works for a reader.**

1. On the first visit nothing is kept yet. After the helper has started (from the **second page** the reader opens), every story and the home page the reader reads is stored on the device automatically: up to **25 pages**, each up to 1 MB, oldest removed first. The reader does not press anything.
2. A story that is stored shows "Saved for offline reading on this device." under its headline.
3. With no connection, stored stories open normally. Home-page cards of stored stories are marked **Available offline**. Photos that were not stored show their description text instead.
4. Opening a page that is not stored shows **You are offline.** with "This page is not saved on this device", a link to the front page and the list **Saved for offline reading** (with the story names as links) and the button **Remove saved copies from this device**.
5. The offline copies never include staff pages, the API, the Give pages, newsletter pages, comments, feeds or push files.
6. The bundled King James text for scripture cards and the verse of the day is also kept (up to 12 books) so devotions work offline.

![A story reopened with the connection switched off: it still opens, and says "Saved for offline reading on this device."](frontend-manual/img/90-offline-article.png)

![A page that was never opened shows the offline page and the list of saved stories.](frontend-manual/img/91-offline-page.png)

![The home page offline: stored text appears, some photos show their description instead.](frontend-manual/img/92-offline-home.png)

**Install prompt.** On supporting browsers (Chrome and Edge on Android and computers) the site can be installed like an app, named "Church Times Nigeria" (shown as "Church Times" under its icon; full screen, no browser bars). The site shows its own banner only when **all** of these are true: the browser itself offers installation, the reader has been on the page about 30 seconds, data saver is off, the app is not already installed, and the reader has not tapped **Install** or **Not now** in the last 60 days. The banner says "Add Church Times Nigeria to your home screen for faster reading, even offline." with **Install** and **Not now**. Tapping either is remembered in the browser (`ct-install-dismissed`). It appears at most once per page.

**How staff control it.** No staff switch. The helper program, app name and icons are built into the site; a developer changes them. The "Saved stories" of this section are automatic copies; they are not the same as the bookmark reading list in section 9.

**For developers.** `tools/public-routes/pwa.mjs` serves `/sw.js`, `/manifest.webmanifest` and `/offline.html`; the worker rules are in `src/features/pwa/sw-core.js`. The helper is registered only in production builds.

---

## 12. Page transitions and the speed features, explained plainly

These happen by themselves. There is nothing for staff or readers to switch, but you may hear the words.

| Feature | In plain words |
| --- | --- |
| **Page transitions** | In browsers that support it (Chrome, Edge), moving from a story card to the story fades smoothly and the headline and photo glide into place. It is skipped for readers who ask their device for less motion. |
| **Prefetch and prerender (speculation rules)** | When a reader hovers or touches a story link, the browser quietly starts loading that story ("prefetch"). It fully prepares the lead newsroom story in advance ("prerender"). Not done in data saver mode. Other browsers simply load pages normally. |
| **Service worker** | The helper program from section 11. Also makes repeat visits faster because the site's own files are already on the device. |
| **Images** | Photos are served in several sizes and in the modern AVIF format where the browser supports it, with a tiny blurred placeholder while the photo loads, so the page does not jump. |
| **Lazy loading** | Extras (search suggestions, gallery, scripture cards, giving, comments) are only downloaded when the reader needs them. |
| **Server-rendered pages** | Story, author, topic, trust, give and calendar pages arrive already complete from the server, so they appear fast and read even with JavaScript off. |

Everything degrades gracefully: a browser without these features just shows the normal site.

---

## 13. The Give page and the thank-you page

**Off by default.** Nothing about giving appears unless **all** of these are true (section 20 repeats them):

1. The CMS has the payment key (`PAYSTACK_SECRET_KEY`) set by your technical helper.
2. In the CMS admin, **Giving settings > Enabled** is ticked, at least one currency is listed, and the CMS has a secure (https) return address (`PUBLIC_SITE_URL`, or `GIVING_RETURN_URL`).
3. The public site was built with the giving address (`VITE_PUBLIC_GIVING_URL`) and the spam-protection key (`VITE_TURNSTILE_SITE_KEY`).

If any one is missing, `/give/` answers "Online giving is not available" (page not found) and no ask appears.

**What a reader sees when it is on.**

- **Support our journalism** ask: a box after the share bar on every story ("Church Times Nigeria is free to read. If this reporting helped you, a one-time gift keeps it independent." with a **Give to Church Times** button) and a **Support our journalism** link in the footer. It is not shown when the browser's own Save-Data setting is on.
- **The Give page** `/give/`: preset amounts (for example ₦2,000, ₦5,000, ₦10,000 and **Other**), a **Currency** list when more than one is offered ("Giving from abroad? Choose your currency here, or give in naira with any international card."), **Where should it go?** (the causes staff listed), **Email address (for your receipt)**, an optional **Name**, **Give anonymously (we will not store your name)**, the box "How we use your details" and the tick box "I agree that Church Times Nigeria may use my details as described above for this gift." The page also shows staff's **bank transfer note** under "Other ways to give". In test mode it shows "Test mode. No real money will be taken."
- **Spam protection.** The reader must allow Cloudflare's spam protection first (see section 18). The button **Allow spam protection** opens the privacy window where the box is ticked.
- **Paying.** The button sends the reader to **Paystack's own secure page** (card, bank transfer or USSD). Card numbers are typed there and never reach Church Times.
- **Thank-you page** `/give/thanks/?reference=...`. It says "We are confirming your payment…" then one of: **Thank you. Your gift was received.** (with the amount and "A receipt is on its way to your email address", plus staff's **thank-you note**), **The payment did not go through.**, **The payment was not completed.**, or **We could not find your payment.** The page always opens, even if giving was switched off meanwhile, and is never saved by search engines.

![The Support our journalism ask under a story.](frontend-manual/img/120-give-ask.png)

![The footer with the extra "Support our journalism" link.](frontend-manual/img/121-footer-with-give.png)

![The top of the Give page.](frontend-manual/img/122-give-page.png)

![Amounts, cause, email, name and the privacy note.](frontend-manual/img/123-give-form.png)

![The Give page on a phone.](frontend-manual/img/127-give-mobile.png)

![The thank-you page after a confirmed test gift.](frontend-manual/img/125-give-thanks.png)

![The thank-you page for a reference we do not know: "We could not find your payment."](frontend-manual/img/126-give-thanks-unknown.png)

**What is stored.** The only browser item is the payment reference, kept for the browser session when the reader *starts* a gift and removed by the thank-you page once it shows a final answer. Nothing is stored on page load. On the CMS side the gift record holds the amount, reference, e-mail and (unless "anonymous") name; card details are never received. Details for finance staff: `apps/cms/docs/w12/giving.md`.

**How staff control it.** CMS admin, **Giving > Giving settings**: **Enabled**, **Provider**, **Currencies** (presets, minimum and maximum are in the smallest unit, so 500000 kobo = ₦5,000), **Causes**, **Thank-you note**, **Bank transfer note**. Gifts are listed read-only in **Giving > Donations** (see the [Staff Manual](staff-manual.md), "Donations").

![Giving settings in the CMS admin. "Enabled" is the master switch for the Give page and the ask.](frontend-manual/img/111-admin-giving-settings.png)

*Currencies.* Paystack cannot charge pounds or euros. Naira is always possible; US dollars only after Paystack has approved the business. A currency Paystack cannot charge is ignored even if listed.

---

## 14. Newsletter: sign-up, confirm, unsubscribe

**Sign-up box: off by default.** The box appears (in the connect band on the home page and at the foot of stories) only when the website was built with the newsletter address (`VITE_PUBLIC_NEWSLETTER_URL`) **and** the spam-protection key. Otherwise the connect band shows **Request updates** (an email to the newsroom).

**How a reader signs up.**

1. Type **Email address** (a **Name** is optional).
2. Tick "I agree to receive the newsletter. I can unsubscribe at any time."
3. Press **Allow spam protection**. The privacy window opens; tick "Allow Cloudflare spam protection for online forms" and close it. A small check runs by itself.
4. Press **Sign up**. The box says: "If this address can be subscribed, we sent a confirmation email." The wording is deliberately the same whether or not the address was already known, so nobody can use the form to find out who is subscribed.
5. The reader opens the email and presses the link. The page `/newsletter/confirm/` shows **Confirm your newsletter subscription** and "Nothing changes until you press the button below." They press **Confirm subscription**, and see "Your newsletter subscription is confirmed." Only then is the reader on the list.
6. Every newsletter email has an unsubscribe link to `/newsletter/unsubscribe/`. The page says **Unsubscribe from the newsletter**; one press of **Unsubscribe** says "You have been unsubscribed."
7. If a link is old or wrong the page says "This link is no longer valid. Please request a new link." Links need pressing a button, so mail programs that pre-open links cannot confirm or unsubscribe anyone by accident.

![The sign-up box in the connect band.](frontend-manual/img/130-newsletter-signup.png)

![Filled in, after allowing spam protection.](frontend-manual/img/131-newsletter-filled.png)

![The answer after Sign up.](frontend-manual/img/132-newsletter-sent.png)

![The privacy window opened by Allow spam protection.](frontend-manual/img/133-consent-dialog.png)

![The confirm page, with an invalid link.](frontend-manual/img/134b-newsletter-confirm-invalid.png)

**How staff control it.** Two separate things:

- **Whether the box exists on the site**: a build setting (section 20). Editors cannot toggle it in the CMS.
- **Whether e-mails are sent**: CMS admin, **Newsletter > Newsletter settings** (editor-in-chief and admin): **Enabled** (the master switch for sending; off by default), **Daily digest enabled**, **Send hour (Lagos)**, **Daily send cap** (a hard limit per day, default 100), **From name**, **Reply-to**, **Max stories per digest**, **Include devotional** (adds the verse of the day). Ticking or unticking these does **not** hide or show the sign-up box. Subscribers appear to the admin under **Newsletter > Subscribers** (see the [Staff Manual](staff-manual.md)).

> **Warning.** For sign-up emails and newsletters to reach readers, the server must have e-mail (SMTP) set up. If it does not, readers still see "we sent a confirmation email" but nothing arrives (section 25, item 6).

---

## 15. WhatsApp prompt, social links and sharing

**WhatsApp prompt.** A white box "Join our WhatsApp group" appears on the home page and near the end of stories. It says it is a **group**, so other members can see your phone number, and that WhatsApp's terms apply. Buttons: **Join the WhatsApp group** and **No thanks**. Pressing either hides it for good on that browser (`ct-whatsapp-prompt`, written only when the button is pressed). The link is an invitation to one group, not a broadcast channel.

![The WhatsApp prompt on the home page (see also the full home page in section 2).](frontend-manual/img/01b-home-full.png)

**Social links.** The footer shows a **Follow us** row: Facebook, X, Instagram, YouTube, WhatsApp, Telegram and TikTok. Links open in a new tab. The same addresses are given to search engines as the publication's official profiles.

**Sharing.** Under each story, **Share this story** has buttons for Facebook, X, WhatsApp, Telegram, LinkedIn and Email (these open the service's own sharing page; nothing is loaded until clicked), plus **Copy link** (says "Link copied.") and, on phones and other devices that support it, a button to use the device's own share menu. The three-dot button in the story header also copies the link.

![The share bar under a story.](frontend-manual/img/17-sharebar.png)

**Share cards (picture shown on social media): off by default.** When a story is shared on Facebook, WhatsApp and similar, the picture is normally the story's photo. If share cards are switched on, an automatic 1200 by 630 card with the label, headline, "Church Times Nigeria" and the date is used for stories **without a photo** (mode `fallback`) or for every story (`always`). The card is drawn by the CMS and needs both the CMS switch and the public host setting (section 20).

![A share card for a story (picture produced by the CMS).](frontend-manual/img/140-share-card.png)

**How staff control it.** The WhatsApp link and the social addresses are in one program file (`src/lib/social-links.js`) and are changed by a developer; there is no CMS setting. The handles for X, Instagram, YouTube, Telegram and TikTok were supplied by the owner and are marked unverified in that file (section 24).

---

## 16. Church calendar and verse of the day

**Verse of the day.** On the home page a quiet box (**Verse of the day**) shows one Bible verse in the King James text with the season and colour, for example "ORDINARY TIME · GREEN". The verse is chosen from lists of verses prepared for each church season, by today's date in Lagos, so every reader sees the same verse on the same day, and feast days have their own verse (Easter, Christmas, Pentecost and others). Nothing is generated or fetched from elsewhere. The box hides itself if the text cannot be loaded. The newsletter can add the same verse when **Include devotional** is ticked (section 14).

**Church calendar.** `/church-calendar/` is a complete page (works without JavaScript) with "Today in Lagos" (the season and liturgical colour), a table of the main feasts and fasts of the year with colours, the seasons with dates, and links to other years (1900 to 2199, `?year=2027`). Dates are calculated from the date of Easter (Western church; Orthodox Easter is shown for reference). The page says colours follow common Roman Catholic and Anglican usage and local practice varies.

![The church calendar page.](frontend-manual/img/27-church-calendar.png)

> **Note.** No menu, footer or story links to the church calendar yet. Readers reach it only by the address, or from a link you place (section 25, item 7).

**How staff control it.** No settings. To change the verses or the calendar rules, a developer edits the program.

---

## 17. Live coverage

**What it does.** A page for live events (a synod, an election, a funeral): published updates in publication order.

**How a reader uses it.**

1. Open **Live coverage** in the menu (`/#live`). A list shows each live event with **Live** or **Coverage ended**.
2. Choose an event. Its title, summary and status appear with **Refresh updates**, **Pause automatic updates** and the time it was last checked.
3. While an event is live the page checks for new updates **every 15 seconds** by itself, but only while the browser tab is visible. New updates are announced politely to screen readers ("2 new updates. 5 published updates shown."). **Load more published updates** shows older ones.
4. Each update has the time (WAT, West Africa Time), optional photo and text.

![The live coverage page with one live event.](frontend-manual/img/28-live-coverage.png)

**How staff control it.** Live events and updates are created and approved by staff in the newsroom app (see the [Staff Manual](staff-manual.md), section 9). Readers see an update only after it is **approved** and an event only when it is available to readers. There is no site setting.

---

## 18. Privacy and consent: what is stored and when

The site is designed so that **nothing optional runs, and nothing is saved in the browser, until the reader acts.**

**The privacy window.** Press **Privacy & reading list** at the bottom of any page (or press **Allow spam protection** in a form). The window "A considered approach to your privacy." explains in plain language what the site does, and has tick boxes, **all off at the start**:

- **Allow configured audience analytics** (counts of visits). Only has an effect when analytics is set up on an indexable site (section 20).
- **Allow Cloudflare spam protection for online forms.** Needed before the newsletter, contact and Give forms can send. Cloudflare's own privacy terms then apply.
- **Allow optional push notifications**: appears only when push is set up (off by default).

Choices are saved in the browser (`ct-optional-consent-v1`) only when ticked.

![The privacy window. Both tick boxes start empty.](frontend-manual/img/81-privacy-dialog.png)

**Everything the site can store, and when.**

| What | Where | Written when | Cleared by |
| --- | --- | --- | --- |
| Theme, contrast, text size (`ct-theme`, `ct-contrast`, `ct-text`) | Browser storage | The reader changes a Display setting | Choosing "Match device" / "Default" |
| Reading list (`ct-reading-list`) | Browser storage | The reader presses a bookmark | **Clear reading list** |
| Consent choices (`ct-optional-consent-v1`) | Browser storage | The reader ticks or unticks a box | Unticking |
| Follows (`ct-following`) and the last Following list (`ct-following-feed`) | Browser storage | The reader presses Follow | **Unfollow** |
| Recent searches (`ct-recent-searches`) | Browser storage | The reader runs a search | **Clear recent searches** |
| WhatsApp prompt hidden (`ct-whatsapp-prompt`) | Browser storage | The reader presses a button on it | Browser data |
| Data saver (`ct-lite`) | Browser storage and a one-year cookie | The reader presses **Data saver** | Pressing it again |
| Install banner dismissed (`ct-install-dismissed`) | Browser storage | The reader presses **Install** or **Not now** | Browser data (re-offered after 60 days) |
| Payment reference (`ct-give-reference`) | Browser session only | The reader starts a gift | The thank-you page |
| Offline copies | Browser cache (`ct-pages-v1` and others) | Automatically, from the second page opened | **Remove saved copies** on the offline page, or browser data |

**Not stored.** No account, no tracking cookie, no advertising profile. Forms do not save drafts. Cloudflare's script loads only after the reader allows spam protection. Analytics and push load only after configuration **and** the reader's tick. Card details never reach Church Times.

*If storage is blocked* (private window, blocked site data) every feature still works for that visit; the reader sees messages such as "Applied for this visit only: browser storage is unavailable."

**How staff control it.** The wording of the window is in the program. Whether analytics or push exist is a build setting (section 20).

---

## 19. Accessibility and keyboard use

The site is built to the web accessibility standard **WCAG 2.2 level AA** and was tested automatically in light, dark and both high-contrast themes (`tests/reader-display.spec.js`). Manual testing with real screen readers is not part of this manual (section 24).

**Keyboard use.**

| Keys | What they do |
| --- | --- |
| **Tab** | Move forward. The first stop on every page is **Skip to content**. |
| **Shift+Tab** | Move back. |
| **Enter** or **Space** | Press the focused button or link. |
| **Esc** | Close a window (search, menu, display settings, privacy) or a scripture card or the suggestion list. |
| **Up / Down** in search | Move through suggestions. **Enter** opens the chosen one. |
| **Tab to a scripture reference, Enter** | Opens its card. |

![The "Skip to content" link appears at the top-left after the first Tab press.](frontend-manual/img/80-skip-link-focus.png)

**Other helps.**

- Windows (search, menu, display settings, privacy) keep keyboard focus inside while open, and the display-settings window returns focus to the button that opened it.
- Every button has a spoken name; icons are labelled ("Display settings", "Search stories").
- Messages such as "Link copied.", "3 suggestions available", live-update announcements and form errors are announced politely.
- Form errors name the field and the problem; the summary receives focus.
- Colour is never the only signal; focus rings are strong; text never goes under 12 pixels; the layout adapts to phone width.
- People who ask their device for less motion get no page transitions or animated effects.
- Dark theme, high contrast and larger text are in section 8.

![The menu on a phone ("Explore Church Times.").](frontend-manual/img/95-mobile-menu.png)

---

## 20. What controls what

**Two kinds of switch.**

- **CMS setting**: something an editor or admin changes in the CMS admin at once.
- **Build or host setting**: an *environment variable* (a named setting kept on the server) that your technical helper sets. Names beginning `VITE_` are baked into the website when it is built, so **changing one needs a new build** of the public site. Names beginning `PUBLIC_` or other server names are read by the public host or the CMS and need a restart.

| Public feature | On by default? | Switch (CMS setting or environment variable) | Verified in |
| --- | --- | --- | --- |
| Home page lead, "In the headlines", "Latest news", "Ideas & public life", section pages | Always | The bundled edition `src/data/stories.json` (developer); lead is story id 29259 | Code, demo |
| "From the newsroom" strip, Latest page, search, topic and author lists | Always | Publish the story (CMS). Needs `VITE_PUBLIC_CMS_URL` at build time and `PUBLIC_CMS_URL` on the public host | Demo |
| Content-type label, kicker, key points, Updated stamp, corrections, pull quote, gallery | Always (each only if filled in) | Story fields: **Content type**, **Kicker**, **Key points**, **Last substantive update**, **Corrections**, body blocks | Demo |
| Byline link and author page | Off per author | Author profile **Is Public** (CMS), and **Byline author** set on the story | Code, demo |
| Topic page and Follow button | Off per topic | Topic **Is Public** (CMS) | Code, demo |
| Editorial standards, Ownership pages | Off | **Site trust pages > published** (CMS) plus text in that page | Code, demo |
| Corrections page and log | Always on | Log is automatic; policy text shows only when Site trust is **published** | Code, demo |
| Give page, "Support our journalism" ask and footer link | **Off** | **Giving settings > Enabled** (CMS) **and** `PAYSTACK_SECRET_KEY` on the CMS **and** a currency **and** `PUBLIC_SITE_URL` (https) or `GIVING_RETURN_URL` on the CMS **and** `VITE_PUBLIC_GIVING_URL` + `VITE_TURNSTILE_SITE_KEY` in the site build | Demo (with a pretend provider) |
| Newsletter sign-up box | **Off** | `VITE_PUBLIC_NEWSLETTER_URL` + `VITE_TURNSTILE_SITE_KEY` in the site build | Demo |
| Newsletter confirm and unsubscribe pages | Always served | Addresses `/newsletter/confirm/` and `/newsletter/unsubscribe/`; links need the CMS to send e-mail (SMTP) | Demo (invalid-link state) |
| Newsletter e-mails (digest) | **Off** | **Newsletter settings > Enabled** (and Daily digest enabled), cap, hour (CMS). Does **not** control the sign-up box | Code |
| Contact form | **Off** | `VITE_PUBLIC_CONTACT_URL` + `VITE_TURNSTILE_SITE_KEY` in the build | Code, demo |
| "Share a story" form | **Off** | `VITE_PUBLIC_SUBMISSIONS_URL` + `VITE_TURNSTILE_SITE_KEY` in the build | Code |
| Share cards (picture for social media) | **Off** | `SHARE_CARDS_ENABLED=true` on the CMS **and** `PUBLIC_SHARE_CARDS=fallback` (or `always`) on the public host. Both must match | Demo |
| Archived comments on old stories | **Off** | `VITE_PUBLIC_COMMENTS_URL` (must end `/api/legacy-comments`) in the build | Demo |
| Advertising | Off until configured | `VITE_PUBLIC_ADVERTISING_URL` in the build, plus campaigns in the CMS. Without it the site uses a built-in empty list | Code only |
| Audience analytics | **Off** | `VITE_PUBLIC_GA4_ID` **and** `VITE_PUBLIC_INDEXABLE=true` in the build, **and** the reader's tick | Code only |
| Push notifications | **Off** | `VITE_PUBLIC_ONESIGNAL_APP_ID` (an id of the form xxxxxxxx-xxxx-...) in the build, and the reader's tick | Code only |
| Search engines may list the site | Off on staging | `PUBLIC_INDEXABLE` on the public host (and `VITE_PUBLIC_INDEXABLE` in the build) | Code |
| Article address shape | `/{slug}/` | `PUBLIC_ARTICLE_PATH_TEMPLATE` on the host and CMS (`/reports/{slug}/` only as a rollback) | Demo |
| Site address | | `PUBLIC_SITE_URL` (host), `VITE_PUBLIC_SITE_URL` (build) | Code |
| WhatsApp group link and social icons | Always on | `src/lib/social-links.js` (developer) | Code, demo |
| Display settings, reading progress, scripture cards, verse of the day, church calendar, Following, search suggestions and filters, data saver, offline reading, install banner, page transitions | Always on | No switch | Demo (install: code) |
| Live coverage | Always on | Live events in the CMS (approved updates only) | Demo |

> **Where to set these.** Host values live in `deploy/public-host/public-host.env.example` (copy it and edit). Build values are in `.env.example` (public Vite build). Never put a secret into any name starting `VITE_`: everything with that prefix is visible to readers.

---

## 21. What readers see in each state

| Place | Loading | Empty | Offline | Error |
| --- | --- | --- | --- | --- |
| Latest reports | "Loading published reports…" | "More stories are on their way." (or "No newsroom reports have been published in this section yet.") | The offline page, or the reports already on screen | "We couldn't reach the newsroom." with **Try again** and a link to the current edition |
| Search results | "Loading published reports…" | "No matching published reports." with "Try another headline, phrase or contributor." | Filters note "You are offline. Newsroom search needs a connection; it will retry when you reconnect." | Same as Latest reports; "More reports could not be loaded. Your stories are still here." when later pages fail |
| Story | "Loading article…" | "The full article text is not available yet. Please check back shortly." | Opens if saved ("Saved for offline reading on this device."); otherwise the offline page | Unknown story: "Article unavailable." ("This report is not available in the published edition."). Newsroom down: "The newsroom is temporarily unavailable." (browsers retry in 60 seconds). "We couldn't load this report." with **Try again** |
| No connection to the CMS at all | | "The newsroom is taking shape. Read our current edition while the new newsroom feed is being prepared." | | |
| Author | "Loading…" | | | "Author unavailable." |
| Topic | "Loading…" | "No published reports in this topic yet." | | "Topic unavailable." or "We couldn't load this topic." with **Try again** |
| Following | "Loading stories…" | "No published stories yet from what you follow." | "You are offline. Showing the list saved <date>." (or "Stories from what you follow will appear when you reconnect.") | "We could not reach the newsroom. Showing the list saved <date>." / "The newsroom is busy. Please try again in a minute." |
| Reading list | | "A little room for good reading." | Works (stored in browser) | |
| Live coverage | "Loading coverage…" | "No updates have been published yet." / "Waiting for the first published update." | "Updates could not be loaded. ... Previously published updates remain here." | "Coverage unavailable. This event is not available to readers." |
| Give page | "Preparing your secure payment…", "Taking you to Paystack…" | | | "Online giving is not available right now." / "We could not reach the payment service. Nothing was charged. Please try again." |
| Thank-you page | "We are confirming your payment…" | "We could not find your payment." | | "The payment did not go through." / "The payment was not completed." |
| Newsletter box | "Sending…" | | | "Sign-up is unavailable. Please try again later." / "Too many requests. Please wait before trying again." / "Complete a new spam-protection challenge and try again." |
| Archived comments | "Loading…" | | | "Archived comments are unavailable. Please try again later." |
| Search suggestions | | "No quick matches. Press Enter to search all stories." | "You are offline, so suggestions are unavailable." | "Suggestions are paused for a moment. Press Enter to search." |
| Pages that do not exist | | | | "A different path. The story continues." with **Back to the journal** |

![The "not found" page.](frontend-manual/img/30-not-found.png)

---

## 22. Troubleshooting

**A story is published but not on the home page.**
Only the three newest appear in "From the newsroom", and only if not already shown. Open **Latest** (`/latest/`) to see all of them. The lead and "Latest news" cards are the bundled edition (section 1).

**The Updated date does not show.**
The **Last substantive update** field is empty, or it is not later than the publication date.

**The author name is not a link.**
The story has no **Byline author**, or that profile is not **Is Public**. Same for topics: the topic must be **Is Public**.

**An editorial standards or ownership page says "not available".**
Site trust pages is not **published**, or that page's text is empty.

**The newsletter box is missing.**
The site was built without `VITE_PUBLIC_NEWSLETTER_URL` and `VITE_TURNSTILE_SITE_KEY`. Newsletter settings > Enabled does not add it.

**"Sign up" says "we sent a confirmation email" but nothing arrives.**
E-mail (SMTP) is not set up on the server, or the message went to spam. Ask your technical helper to check the server's e-mail settings.

**A form will not send; it says "Allow spam protection before sending."**
The reader has not ticked "Allow Cloudflare spam protection for online forms" in the privacy window. Ask them to press **Allow spam protection** and tick the box.

**The Give page says "Online giving is not available".**
One of the four conditions in section 13 is missing. Ask your technical helper to open `GET /api/giving/stats` as an admin; its `offReason` names what is missing (for example, no secure return address).

**Share cards do not appear when sharing.**
Both `SHARE_CARDS_ENABLED=true` (CMS) and `PUBLIC_SHARE_CARDS` (public host) must be set and match. Social networks also keep old previews for a while; the card address changes whenever the story is edited, so a fresh share shows the new one.

**A reader says the site is dark, large or different.**
They chose it in Display settings, or their device asks for dark or high contrast. Display settings > **Match device** and **Default** reset it.

**Photos are grey boxes.**
Data saver is on. Press **Show images** or press **Data saver** to turn it off.

**Offline: "This page is not saved on this device."**
The reader has not opened that page since the helper program started. Stories open offline only if they were opened (online) before. The very first page on a new device is not stored.

**The site looks out of date after a release.**
The helper program renews itself when a new version is released; a reader who sees an old version should close all site tabs and reopen.

**Reading list is empty on a new phone.**
Lists, follows and recent searches live in one browser only. They do not move between devices.

**Scripture reference is not underlined.**
It is not a valid passage (for example a chapter that does not exist), or it is inside a heading or link. Cards use the King James Version only.

---

## 23. Glossary

| Word | Meaning |
| --- | --- |
| **AVIF** | A modern photo format that makes pictures smaller. |
| **Bundled edition** | The 21 fixed stories built into the website program (section 1). |
| **Build** | Making the finished website files from the program. Settings beginning `VITE_` are fixed at build time. |
| **CMS** | Content management system: the back office where stories and settings are stored. |
| **Cloudflare Turnstile** | A free spam check shown before forms send. It loads only with the reader's permission. |
| **Content type** | The kind of story: News, Analysis, Opinion, Sponsored, Explainer, Fact-check. |
| **Data saver** | Setting that holds photos back until asked (section 10). |
| **Deck** | The summary line under the headline. |
| **Environment variable** | A named setting kept on the server, not in the program. |
| **Kicker** | A short label above the headline. |
| **KJV** | King James Version of the Bible, public domain, built into the site. |
| **Lite mode** | Another name for data saver. |
| **PWA** | Progressive web app: a website that can be installed and can work offline. |
| **Prefetch / prerender** | The browser loading a page before the reader presses the link. |
| **Public host** | The server program that delivers the public website and renders its pages. |
| **Pull quote** | A highlighted quotation set apart in the story. |
| **Service worker** | The helper program in the browser that keeps offline copies. |
| **Share card** | An automatic picture used when a story is shared on social media. |
| **SMTP** | The way the server sends e-mail. |
| **Speculation rules** | The browser instructions that allow prefetch and prerender. |
| **Topic** | A subject, denomination, series or ministry that stories belong to and readers can follow. |
| **WAT** | West Africa Time, the time zone used on the live page. |

---

## 24. Not verified

These could not be checked in the practice copy. Please check them on your real system.

1. **Install banner.** It needs a real browser installation event and 30 seconds of reading. Described from the code only.
2. **Successful newsletter confirm and unsubscribe.** The practice copy cannot send e-mail, so we never held a genuine link. The invalid-link state was checked; the success messages are from the code.
3. **Real Paystack checkout and the receipt e-mail.** A pretend provider was used. The thank-you page was checked with a confirmed test gift. The live provider, its fees, the bank-transfer and USSD screens and the receipt e-mail were not seen.
4. **Real Cloudflare Turnstile.** Cloudflare's always-pass test key was used.
5. **Audience analytics, push notifications and live advertising on the public site.** They are not configured in the practice copy. Only the code was read.
6. **Data saver switching on by itself from the browser's Save-Data signal.** The button was tested; the automatic switch was read from the code.
7. **Page transitions, prefetch and prerender.** Chromium behaviours that are invisible to a screenshot.
8. **Live coverage updates arriving.** The page and its controls were seen; the 15-second refresh with a new update being posted was not watched.
9. **Printing.** The print rules were read from the code, a printed page was not produced.
10. **Screen readers (NVDA, VoiceOver, TalkBack), Safari and Firefox.** Only desktop and phone-sized Chromium was used.
11. **Share cards on real social networks**, and how Facebook or WhatsApp cache them.
12. **Church calendar and verse of the day accuracy.** The pages were viewed; the dates and verse choices were not checked against a church calendar.
13. **Social handles.** The Facebook page and the WhatsApp group link are from the owner's current site; the X, Instagram, YouTube, Telegram and TikTok handles are marked unverified in `src/lib/social-links.js`.
14. **Follows, reading list and offline copies on a second device.** They are single-browser by design; not tested across devices.
15. **The "Newsletter settings" screen.** Its fields were read from the code; the screen itself was not captured.

---

## 25. Things that look like faults (for the developers)

Nothing was changed. These are for the team to decide.

1. **Fixed dates.** The masthead date "Monday, 5 October 2026" and the footer line "Selected coverage · updated 5 October 2026" are fixed text in `src/main.js`; they show on the home, author, topic, trust, give and confirm pages instead of today's date.
2. **Home page and section pages are not editor-controlled.** The lead is hard-coded (story id 29259, `selectHomepage()` in `src/lib/homepage.js`) from a 21-story bundled file, and section pages such as News list only that bundle, not CMS stories. A newly published CMS story reaches the home page only in the three-card "From the newsroom" strip.
3. **Topic list is not linked.** `/topic/` is not in the menu, footer or search, and story pages do not show their topics, so topic pages and the Follow button can be reached only by a direct link or from an author page.
4. **"More to consider" related stories** exist only for the bundled edition; CMS stories have no related-stories block.
5. **Reading-list bookmark** is not on CMS story cards or story pages (`reportCard()` has no save button), so a reader cannot save a published newsroom story to their list. Offline copies are automatic instead.
6. **Newsletter wording with no e-mail.** Sign-up always says "we sent a confirmation email", even on a server with SMTP off. In the practice copy the confirmation link is only written to the CMS developer log.
7. **Church calendar is not linked** from anywhere on the site.
8. **Newsletter settings > Enabled** only controls sending. The sign-up box and the subscribe endpoint do not read it, so people can subscribe while sending is off.
9. **Support ask and Save-Data.** The Give ask is hidden when the browser's own Save-Data flag is on, but not when the reader presses the footer **Data saver** button.
10. **Offline home page** shows broken-image alt text ("Featured image from the original Church Times") for edition photos that were not cached.
11. **Search suggestion titles** of the invented demo stories show a literal `&#8217;` in the text (the demo data itself contains the entity). Real titles were not affected in the practice copy.
12. **Demo script ports (local only).** `apps/cms/scripts/demo.ts` picks the public-site port before the newsroom server has bound its own, so when 5174 is busy both choose 5175 and the public site fails to start ("EADDRINUSE"). The probe also reports a port free when an older demo holds it on 127.0.0.1 only. A local, uncommitted edit was used to work around both.
