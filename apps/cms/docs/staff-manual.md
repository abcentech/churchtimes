# Church Times Nigeria: Staff Manual

For reporters, section editors, the editor-in-chief, admins and trusted publishers. You do not need to be technical. If a word is new, it is explained the first time it appears.

Screens change a little over time. Where a picture would help, you will see a note like [screenshot: ...]. Your trainer can add the pictures.

## Contents

1. What the system is
2. Logging in, roles and the "four-eyes" rule
3. Writing a story
4. The story workflow
5. For editors: review, approve, publish, correct
6. Archive review (recovered old stories)
7. Comments
8. Ads, redirects, live events and reader messages
9. What readers see on the public site
10. Troubleshooting and who to call
11. Quick-reference cards (one per role)

---

## 1. What the system is

Church Times Nigeria runs on three connected parts. You will use the first two every day.

| Part | Who uses it | What it is for | Address (your IT person will give you the real ones) |
| --- | --- | --- | --- |
| **Newsroom app** | Everyone on staff | Write stories, review them, publish, run live coverage, manage photos. | `https://newsroom.<your-domain>` |
| **CMS admin** | Admins and editors, sometimes others | The back office. Add staff, manage ads, redirects, comments and anything the newsroom app does not cover. "CMS" means content management system: the place where all stories and files are stored. | `https://cms.<your-domain>/admin` |
| **Public site** | Readers | What the public reads. | `https://www.<your-domain>` |

Things to know:

- A story you write in the newsroom app is stored in the CMS. The public site shows it only after it is **published**.
- The newsroom app and the CMS admin use the **same account**. Sign in to each separately.
- The newsroom app works in a modern browser (Chrome, Edge, Firefox, Safari) on a computer or a phone.
- Dark mode: click the **Dark** button at the top. It becomes **Light** to switch back.

[screenshot: the three addresses open in three browser tabs]

### Trying it on your own computer (practice copy)

You can run a safe, throw-away copy with about 300 invented stories. Nothing you do touches the real website. It is meant for training. The setup is for whoever helps you with technology. The steps are in `apps/cms/docs/local-demo.md` (look for "Try the whole system on your own computer"). The short version: install Node.js, open PowerShell in the `apps\cms` folder, run `npm run demo`, then wait for **DEMO IS READY**. It prints the addresses. The demo has five practice accounts, one for each role. Their passwords are saved in a file on that computer, not shown on screen.

---

## 2. Logging in, roles and the "four-eyes" rule

### Log in to the newsroom app

1. Open `https://newsroom.<your-domain>`.
2. You see **Staff sign-in**.
3. Type your **Email address** and **Password**.
4. Click **Sign in**.
5. You land on the **Editorial Newsroom Desk**. Your name and role show at the top right.

[screenshot: Staff sign-in screen]

Good to know:

- Passwords must be at least **12 characters**. Very common passwords are refused. Use a few words you can remember.
- After **5 wrong tries** your account locks for **10 minutes**. Wait, then try once more carefully.
- A sign-in lasts **8 hours**. While you are busy typing or clicking, the app extends it for you.
- If the app says "Your session has ended. Please sign in again.", sign in again. You come back to the page you were on.
- Click **Log out** (top right) when you finish on a shared computer.
- To change your own password or email in the CMS admin, you must type your current password first.
- Forgotten your password? Ask an admin to send a reset link. The link works for **1 hour**.

### The screens (top menu)

| Menu item | What it is | Shortcut |
| --- | --- | --- |
| **Newsroom Desk** | List of all stories you may see, with counts. | Alt+1 |
| **Write Story** (and **+ New Story**) | The story editor. | Alt+2 |
| **Review Queue** | Stories waiting for an editor, plus reader tips. A number shows how many are waiting. | Alt+3 |
| **Live** | Live coverage of an event. | Alt+4 |
| **Media Library** | Photos with credits and descriptions. | Alt+5 |
| **Archive Review** | Recovered old stories. Shown to editors only. | Alt+6 |

On a phone, a bar at the bottom shows Desk, Write, Review, Live and Media. In the editor, **Ctrl+S** saves your draft.

### The five roles

Your role is set by an admin. It shows next to your name.

| Role | In plain words |
| --- | --- |
| **Reporter** | Writes drafts and sends them for review. Cannot approve, publish, schedule or archive. Not even their own story. |
| **Trusted publisher** | A reporter who may publish or schedule **their own** stories, but only in the sections the admin gave them. Cannot approve other people's work. |
| **Section editor** | Edits one or more sections (for example Politics). Can review, approve, send back, publish and archive stories **in those sections only**. |
| **Editor-in-chief** | Same as section editor for **every** section. Can also delete stories, manage ads and redirects, and read the audit log. |
| **Admin** | Everything the editor-in-chief can do, plus managing staff accounts and newsletter subscribers. |

A **section** is a category such as News, Opinion or Sports. Each story has one main section.

### What each role can do

"Yes" means the system allows it. "Own" means only stories you wrote.

| Action | Reporter | Trusted publisher | Section editor | Editor-in-chief | Admin |
| --- | --- | --- | --- | --- | --- |
| Start a story, upload photos | Yes | Yes | Yes | Yes | Yes |
| Edit a story | Own, while Draft or Changes Requested | Own (in their sections) | Any story in their sections | Any | Any |
| Submit for review | Own | Own | Yes | Yes | Yes |
| Approve or request changes | No | No | In their sections | Yes | Yes |
| Publish or schedule | No | Own, in their sections | In their sections | Yes | Yes |
| Archive (take down) a published story | No | No | In their sections | Yes | Yes |
| Delete a story | No | No | No | Yes | Yes |
| Post a live update | Yes (needs approval) | Yes | Yes | Yes | Yes |
| Create and run live events | No | In their sections | In their sections | Yes | Yes |
| Review reader tips | No | No | Yes | Yes | Yes |
| Archive review screen | No | No | Yes | Yes | Yes |
| Hide or restore old comments | No | No | In their sections | Yes | Yes |
| Ads, advertisers, redirects, reader messages | No | No | No | Yes | Yes |
| Read the audit log (who did what) | No | No | No | Yes | Yes |
| Add or change staff accounts | No | No | No | No | Yes |
| Newsletter subscriber list | No | No | No | No | Yes |

The app hides buttons you may not use. If a button does appear but the system still refuses, you see a message such as "Not permitted". That is normal. Ask your editor.

### The four-eyes rule

"Four eyes" means two different people look at something before it goes public.

What the system really enforces today:

- **Reporters never publish.** A reporter cannot approve, publish, schedule or archive anything, including their own story. A second person must always do it.
- **Recovered archive stories** (see section 6): the editor who **approves** a recovered story **cannot** also publish or schedule it. A different editor must. The system answers "A different editor must publish a recovered article you approved." Admins may do both.
- **Ordinary stories:** an editor in the right section who approves a story is allowed to publish it. Your newsroom may choose to be stricter than the system. If so, that is a house rule, not a button that is switched off.

---

## 3. Writing a story

### Start a story

1. Click **+ New Story** at the top, or **Write Story** on the Desk.
2. Fill in the fields below.
3. Click **Save Draft**.

[screenshot: the story editor with all fields]

### The fields, top to bottom

| Field | What to do |
| --- | --- |
| **Headline (Story Title)** | Up to 240 characters. Clear and true. Required. |
| **Standfirst / Deck** | A one or two sentence summary under the headline. Up to 600 characters. (A standfirst is the short intro line readers see before the story.) |
| **Editorial Section** | Pick the main section. This decides which editors can approve it. |
| **Also appears in** | Tick up to **5** extra sections where the story should also show. The main section cannot be ticked again. |
| **URL Slug** | The last part of the web address. It is made from the headline if you leave it empty. Use letters, numbers and hyphens. Up to 160 characters. See the note below. |
| **Byline shown to readers** | Optional. Leave empty to use the author's name. Up to 200 characters. |
| **Featured Photograph** | The main picture. Click **Choose or upload a photograph**. |
| **Story Content** | The body of the story. |

Notes:

- The slug becomes the public address: `https://www.<your-domain>/<slug>/`. Some words are reserved by the system (for example `admin`, `api`, `search`, `contact`, `newsletter`, `login`). If you choose one, the system refuses it.
- **After a story is published, the slug is locked** in the newsroom app. Only the editor-in-chief or an admin can change it. The system then adds an automatic redirect from the old address, so old links keep working.
- If a story came from a reader's tip, the byline is filled with the reader's name. Check it and change or clear it if needed.

### Formatting the body

Above the body are buttons: **B** (bold), **I** (italic), **H2** (section heading), **H3** (sub-heading), **Quote**, **List** (bullets), **Link** and **Insert image**.

- Select text, then click a button.
- Links must start with `http://`, `https://` or `mailto:`.
- Click **Toggle Preview** to see roughly what readers will see.
- A counter shows words and reading time.

Some stories cannot be edited in the newsroom body box. These include stories with embedded videos, tables or special formatting, and most recovered old stories. A notice says so. You can still change the headline and other fields. The body can only be edited in the CMS admin. This is on purpose, so nothing is lost.

### Photos

**Put a photo in the story**

1. Put the cursor where the photo should go.
2. Click **Insert image**.
3. Pick a photo from the library, or upload a new one.
4. A line like `![description](media:12)` appears. Leave it as it is.

**Upload a new photo** (from the picker, or **Upload Photograph** in the Media Library)

1. Choose the file. Allowed types: **JPEG, PNG or WebP**.
2. Type the **Alt text** (required). This is a short description of what is in the picture, for readers who cannot see it and for search engines. Up to 300 characters. Example: "Archbishop greeting worshippers outside the cathedral in Abuja".
3. Type the **Photographer / credit**. Please always fill this in.
4. Type a **Caption** if the picture needs one.
5. Click the upload button.

**Size limits**

- Images: the system refuses files above its size limit. The default limit is **25 MB**. The upload form in the app currently says "max 10 MB". Treat 10 MB as the safe number. Please see the unverified list at the end of this manual. Photos from a phone camera are normally under this. If it is too big, make it smaller (see section 10).
- The system removes hidden location and camera data from images when you upload. Very large pictures in pixels are also refused.
- The featured photograph must be an image, never audio or video.

If an image in the body is missing from the library, the editor shows a **Missing image** box. The system will not save the story until you click **Remove** on it.

### Audio and video

- Allowed files: **MP4 or WebM** (video), **MP3, M4A or OGG** (audio). The default size limit is **100 MB** per file.
- The newsroom upload box accepts photos only. Upload audio and video in the **CMS admin** (Media), then add it to the story body in the CMS admin using the **Audio or video** block. Pick the file, add a title and a caption, and optionally a poster picture (the still picture shown before a video plays).
- YouTube videos are added in the CMS admin with the YouTube block.
- A story that holds these blocks opens with a read-only body in the newsroom app. Edit the body in the CMS admin.

[screenshot: CMS admin, Audio or video block in a story]

### Saving, autosave and the offline banner

At the top of the editor you see a small status next to the story status:

| What you see | What it means |
| --- | --- |
| **Not saved yet** | A brand new story. Click **Save Draft** once to create it. |
| **Saved** or **All changes saved** | Everything is stored. |
| **Unsaved changes...** | You typed something. Autosave will store it in a moment. |
| **Autosaving...** then **Autosaved 10:42:05** | The app saved it for you. |
| **Unsaved changes (use Save Draft)** | Autosave is off for this story. Click **Save Draft** yourself. |
| **Autosave failed (see message above)** | Read the red message and fix the problem, then save. |

Autosave only works on stories you already saved once, and only while they are Draft or Changes Requested. It never changes a published story. Save a new story yourself the first time. Use **Ctrl+S** any time.

**Red banner: "You are offline or the CMS cannot be reached. Changes are not being saved."** This appears at the top of the page when your internet drops or the CMS is down.

1. Do **not** close the tab and do not press refresh.
2. Your text stays on the page and a copy is kept in this browser tab.
3. Wait until the banner disappears, then click **Save Draft**.
4. If it does not go away, click **Copy my text** (if shown) or select all and copy the body into a Word file as a backup. Then call IT (section 10).

If you open the story again and the app finds unsaved text from before, it asks **Restore my text** or **Discard it**. If the story changed on the server in the meantime, restoring may replace newer edits, so look first.

If you try to leave with unsaved changes, the app warns you and offers **Leave without saving**.

**"Someone else changed this story" (conflict).** If an editor saved the story while you were typing, you see a red message with **Copy my text** and **Reload story**. Click **Copy my text** first, then **Reload story**, then paste your changes back in.

### Send it for review

1. Check the headline, section, photo credit and alt text.
2. Click **Submit for Review**. The status becomes **In Review**.
3. Editors see it in the Review Queue.

You can no longer edit it as a reporter while it is In Review. Ask the editor to send it back if you need to change something.

---

## 4. The story workflow

Every story has a status. You see it as a badge at the top of the editor and in the Desk list.

```
Draft --> In Review --> Approved --> Published
            |   ^                        |
            v   |                        v
     Changes Requested               Archived
Approved --> Scheduled --> Published (automatically)
```

| Status | Meaning | Who moves it forward |
| --- | --- | --- |
| **Draft** | Being written. | The author clicks **Submit for Review**. |
| **In Review** | Waiting for an editor. | An editor clicks **Approve Story** or **Request Changes**. |
| **Changes Requested** | The editor sent it back with notes. | The author fixes it and clicks **Submit for Review** again. |
| **Approved** | The editor is satisfied. Not public yet. | An editor (or the author, if a trusted publisher) publishes or schedules it. |
| **Scheduled** | Will publish by itself at a set time. | The system publishes it at that time. |
| **Published** | Live on the public site. | An editor may archive it. |
| **Archived** | Taken off the public site. Not deleted. | An editor may publish it again. |

Shortcuts:

- An editor may publish straight from Draft, In Review or Approved.
- A trusted publisher may publish or schedule their own story straight from Draft, in their own sections.
- A reporter can only do Draft to In Review.

### When an editor sends your story back

1. Open the story. A box shows the editor's notes ("review notes").
2. Make the changes. Save.
3. Click **Submit for Review** again.

### Scheduling a story

Scheduling means "publish this later, automatically." Only people who can publish see the **Schedule publication** panel.

1. Save the story first (the panel shows only for a saved story).
2. In **Schedule publication**, set **Publish at (your local time)**. It starts at one hour from now.
3. Click **Schedule**. The status becomes **Scheduled** and the panel shows "Scheduled to publish automatically on ...".
4. To change the time, set a new time and click **Reschedule**.
5. To cancel, an editor moves it back (Approved or Draft) in the CMS.

The time must be in the future. If not, you see "scheduledFor must be in the future." Check your computer clock and time zone. The system checks for due stories every few moments, so a story may go live a short time after the exact minute.

[screenshot: Schedule publication panel]

---

## 5. For editors: review, approve, publish, correct

This section is for section editors, the editor-in-chief and admins. Section editors only see and act on stories in their own sections.

### The Review Queue

Open **Review Queue**. Four tabs, each with a count:

| Tab | What is in it |
| --- | --- |
| **In Review** | Stories waiting for you. |
| **Reader Tips & Submissions** | Tips and stories sent by readers through the public site. |
| **Revisions Requested** | Stories you sent back. |
| **Approved Ready** | Approved stories not yet published. |

[screenshot: Review Queue tabs]

### Review a story

1. In **In Review**, click **Inspect & Fact-Check** on a story. (Or **Open in editor** for the full editor.)
2. Read the story in the window. A checklist helps you think: named sources corroborated; subject dignity and consent verified and right of reply given; image rights cleared and alt text provided.
3. Choose one:
   - **Request Changes**: a box opens. Write clear notes for the reporter. Click **Send Revision Request**. The reporter sees your notes.
   - **Approve Story**: the story becomes Approved.
   - **Publish Live**: publishes now, after you confirm.
4. If you see a warning that the body has video or table content that is not shown, open the story in the CMS admin and check it before approving.

You may also edit the story yourself in the full editor, then use the buttons at the top: **Request Changes**, **Approve Story**, **Publish Story**.

### Publish

1. Click **Publish Story** (or **Publish Live**).
2. A box asks "Publish this story to the Church Times Nigeria live web feed now?" Click **Publish now**.
3. You see "Story is now live and published!"

If the Publish button is grey, read the short note under it. The usual reason is a recovered archive story (see section 6).

If you see "The story was changed by someone else", the app reloads it. Look at the new version and try again. This protects you from approving something that changed after you read it.

### Unpublish (take a story down)

There is no "unpublish" button by that name. The button is **Archive**.

1. Open the published story.
2. Click **Archive** (editors only).
3. Confirm "Archive this story and remove it from the public site?"

The story leaves the public site but is not deleted. To bring it back, an editor publishes it again.

**Delete** (editor-in-chief and admin only) is for mistakes. It is permanent. Prefer Archive. A story that still has old reader comments attached cannot be deleted.

### Corrections after publishing

1. Open the published story and fix the text.
2. Click **Save Draft**.
3. A box asks for a **correction note**. Describe what changed, for example "The bishop's name was misspelled. It has been corrected."
4. Click **Save with correction**.

The system will not save a change to a published headline, standfirst or body without a note. Corrections are added to the record and are not removed. Only the editor-in-chief or an admin can amend an existing correction note. Autosave never touches a published story.

### Reader tips

In **Reader Tips & Submissions**, use the **Show:** filter to pick which tips to see.

1. Read the tip. You see the reader's message and how to reach them.
2. To use it, click **Convert to Draft Story**. Pick a **Section for the new story** and click **Create draft story**. The editor opens with a new draft. The reader's name is placed in the byline. Change it if needed.
3. To refuse it, click **Dismiss Tip** and give a reason. The reason is kept on record.
4. A converted tip has an **Open story** button.

Readers send tips from the public site (the "Share a story" form at `https://www.<your-domain>/#submit`).

### Push notifications

Push notifications (alerts sent to readers' phones and browsers) are **not switched on**. The code is built but off. No staff button sends them. Please ask the owner before promising readers any alerts. For breaking news today, use the Live screen and your social media.

### Live coverage (editors and live reporters)

Open **Live**.

1. Click **+ New Event**. Enter the **Event Title**, choose a **Section**, add a **Summary**. Click **Create event (draft)**.
2. When ready, click **Go Live**. Click **End Coverage** when finished.
3. To post, type in **Update Content** (plain text, up to 5000 characters), optionally click **Add photo**, then click **Publish Live Update** (or **Submit Update for Editorial Review** if you cannot approve).
4. If you can approve (editor, or trusted publisher in that section), your update goes public at once: "Live update published to public timeline!"
5. Otherwise it says "Update submitted for editor approval." An editor sees it under **Updates Awaiting Approval** and clicks **Approve & Push Live** or **Reject**.
6. The timeline refreshes every few seconds. Click **Refresh** to refresh now.

Reporters can post updates but never publish them directly. Creating and running events is for editors and trusted publishers in the event's section.

[screenshot: Live screen with timeline]

### Media Library

Open **Media Library** to browse photos. Use the search box (it searches the alt text). Click a photo to see its alt text, caption and credit. Anyone can upload. Fixing a wrong credit or alt text on an existing photo is done in the CMS admin by an editor.

---

## 6. Archive review (recovered old stories)

Old stories from the previous website were recovered and loaded as **drafts**. They are not public. Editors check each one here before it can be published. Reporters do not see this screen.

### Find stories to check

1. Click **Archive Review** (Alt+6).
2. Use the filters: **Review status** (pending, reviewed, rejected), **Recovery confidence** (partial, citation-only, missing) and **Import batch**.
3. Counts show next to each choice.
4. Each row shows the title, the date the old page claimed, the source website and a confidence badge. Click to open it.

Confidence means how much of the old story was recovered:

| Level | Meaning |
| --- | --- |
| **Partial** | Some text recovered. |
| **Citation-only** | Only a reference to the story was recovered, not the full text. |
| **Missing** | Little or nothing recovered. |

### Review one

1. The recovered text is on the left. Details about where it came from are on the right: source address, website, date claimed, when it was captured, confidence and batch.
2. The source address is shown as text with a link. It opens **only when you click it**, in a new tab. The app never loads the old page by itself.
3. If the story contains links to websites the newsroom does not know, a box lists them. Check them and tick **I checked the links** before you can approve.
4. Choose:
   - **Approve**: you are satisfied the story is accurate and safe to run. Confirm the box.
   - **Reject**: do not use it. It stays a draft. Confirm the box.
   - **Open in editor**: opens the normal story editor.

Who may approve or reject: admin, editor-in-chief, or the section editor of that story's section.

### What approval does not do

- Approving does **not** publish. The story still goes through the normal steps. It cannot be published or scheduled until it is approved here. The Publish button is grey with a note.
- **Four eyes:** the person who approved it cannot publish or schedule it. The note says "You approved this recovered story, so a different editor must publish or schedule it." A different editor publishes it. An admin may do both.
- The review screen shows "Approved by <name> on <date>" to editors.

If the screen says the story changed and reloads, someone else touched it. Look again and retry.

[screenshot: Archive review screen]

---

## 7. Comments

**New comments are not open on the public site.** Under some stories, readers see a section called **Archived comments**. These are comments from the previous website. They are read-only. The site says: "This archive is read-only; new comments are not accepted."

What staff can do (in the CMS admin, **Legacy comments**):

1. Open **Legacy comments** and search by commenter name or text.
2. Open a comment. Change **Status** from **Approved** to **Hidden**. Save. Readers no longer see it.
3. To bring it back, set the status to **Approved** again.

Rules:

- Editor-in-chief and admin can do this for any comment. A section editor can do it for stories in their sections.
- You cannot edit the words, the name or the date. You can only hide or restore.
- Only an admin can delete a comment. Every hide, restore and delete is logged.
- Hide comments that break your house rules, for example abuse, private details or false claims.

---

## 8. Ads, redirects, live events and reader messages

These are in the **CMS admin** (`https://cms.<your-domain>/admin`), not the newsroom app. Live events are also in the newsroom app (section 5).

### Advertising (editor-in-chief and admin)

There are two lists: **Advertisers** (who is paying) and **Ad campaigns** (the actual placements).

1. Add the advertiser first. Never store card or bank details.
2. Create a campaign: sponsor name, a description of the ad (alt text), the web address it links to (must be `https://`), the picture or pictures, **start** and **end** date and time.
3. Tick the box that says a person has checked the rights to the creative and permission from the advertiser.
4. Set the campaign status to **approved** (the choices are draft, pending_approval, approved, paused, cancelled) and the payment status to **paid** (unpaid, invoiced, paid, waived). Only an admin can mark a campaign **waived** (free).

An ad shows to readers **only** when all of these are true: approved, paid or waived, and inside its dates. If an ad does not show, check each one.

### Redirects (editor-in-chief and admin)

A redirect sends a reader from an old web address to a new one so old links do not break.

1. Open **Redirects** and click create.
2. **From**: the old path, for example `/old-story/`.
3. **To**: the new path, for example `/new-story/`. Leave it empty only for "gone".
4. **Status**: **301** moved for good, **302** temporary, **410** gone (the page was removed on purpose).
5. Save. The system refuses redirects that loop or chain.

When you change the slug of a published story, the system creates the redirect for you.

### Live events

See section 5. In the CMS admin they appear under **Live events**. Only the editor-in-chief and admin can delete one.

### Reader messages (editor-in-chief and admin)

The public **Contact** form sends messages to **Contact messages** in the CMS admin. Read them, reply by email, and change the status as you go.

### Newsletter subscribers (admin only)

The list of people who signed up. You can mark someone as unsubscribed or bounced. You cannot add people by hand, because people confirm their own sign-up by email.

### Staff accounts (admin only)

In the CMS admin, **Users**. To add a person: create the user, set their **role**, and for section editors and trusted publishers choose their **sections**. Without sections, they cannot act on any story. A new admin cannot be created by sign-up. Changes of role are logged.

### Audit log (editor-in-chief and admin)

**Audit logs** in the CMS admin is a record of who did what and when (publishing, role changes, redirects, comment hides). Use it to answer "who published this?"

---

## 9. What readers see on the public site

### Stories and addresses

- Each story has its own page. The address is `https://www.<your-domain>/<slug>/`. Example: `https://www.<your-domain>/synod-opens-in-abuja/`.
- Sections have their own pages, at `/category/<section>/`.
- Each story shows the headline, standfirst, byline, publication date, photo with caption and credit, and the body. Audio and video play on the page.
- A story that is also ticked into extra sections appears on each of those section pages.
- Old addresses that you set up in **Redirects** forward to the new page.

[screenshot: a story page on the public site]

### Search

Readers click the search icon, type words and see matching published stories. Drafts, scheduled and archived stories never appear.

### Consent prompt (privacy choices)

Readers get a privacy panel titled **Optional services**. Everything is **off unless they choose**:

- Allow audience analytics (counts of visits).
- Allow Cloudflare spam protection for online forms (needed to send the contact, tip and newsletter forms).
- Allow optional push notifications (only appears if push is switched on, which it is not today).

Choices are saved in the reader's browser. If a reader says forms will not send, ask whether they allowed the spam protection.

### Newsletter

Readers type their email in the "News worth reading, in your inbox." box. They get an email with a confirmation link. They are on the list only after clicking it. Every email has an unsubscribe link.

### Contact and "Share a story"

- **Write to the newsroom** sends a message to Contact messages (section 8).
- **Share a story** (tips) needs name, phone, the message and consent. It arrives in the Review Queue under Reader Tips.
- If online sending is down, the form says so and shows an email address to write to.

### Comments

Only **Archived comments** from the old site, read-only (section 7).

### What readers never see

Drafts, in-review, approved-but-not-published, scheduled-before-time and archived stories. Also review notes, reader tips, tip contacts, and all information about recovered-story sources.

---

## 10. Troubleshooting and who to call

### Quick answers

**"Cannot reach the CMS" (with a Try again button).** The app cannot talk to the back office.
1. Click **Try again**.
2. Check your internet. Open another website.
3. If other sites work and it still fails, the CMS is down. Call IT (below). Do not keep clicking.

**Red banner "You are offline or the CMS cannot be reached. Changes are not being saved."** See section 3. Keep the tab open. Do not refresh. Save when it clears.

**"Your session has ended. Please sign in again."** Sign in again. You return to the same page.

**I cannot sign in.**
1. Check that Caps Lock is off.
2. Check your email address for typing mistakes.
3. After 5 wrong tries wait 10 minutes.
4. Still stuck: ask an admin for a password reset link.

**I cannot publish my own story.** If you are a reporter, that is the rule. Click **Submit for Review**. An editor publishes it. If you are a trusted publisher and still cannot: your story must be in one of your own sections, and you must be the author. Ask an admin to check your sections.

**I do not see the Archive Review menu / Publish button / Approve button.** Your role does not allow it, or the story is outside your sections. See the table in section 2.

**I cannot edit a story.** Reporters can only edit their own stories while they are Draft or Changes Requested. Once it is In Review, only an editor can edit it. A story with video, tables or special formatting has a read-only body. Use the CMS admin.

**The Publish button is grey with a note about a recovered story.** It needs archive review first, or a different editor must publish. See section 6.

**"Not permitted" or "Not permitted to move an article from ... to ...".** Your role cannot do that step. Ask an editor.

**Image too large.** The message says "Images must be at most N MB."
1. Open the photo on your computer or phone.
2. Use "Resize" or "Export" and choose a medium or web size (about 2000 pixels wide is plenty).
3. Or save it as JPEG at lower quality.
4. Upload again. Send a copy to your editor if you cannot shrink it.

**"Unsupported or corrupt file."** The file is not a real JPEG, PNG or WebP. Do not just rename a file. Re-export it from a photo app. For audio and video use MP4, WebM, MP3, M4A or OGG.

**"Alt text is required."** Type a short description of the picture. It cannot be empty.

**The system asks for a correction note.** You are editing a published story. Describe what you changed. See section 5.

**"This story was changed by someone else."** Click **Copy my text**, then **Reload story**, then paste your changes in again.

**My scheduled story did not appear.** Open it. If it says Scheduled with a time in the future, wait. If the time has passed, tell IT. Also check the time zone of your computer.

**The slug cannot be changed.** The story is published. Ask the editor-in-chief or an admin.

**A reader says they cannot send a form.** They may have declined "Cloudflare spam protection for online forms" in the privacy panel, or the service is busy. Ask them to try again later or to email the newsroom.

### Good habits

- Save often. Use **Ctrl+S**.
- Fill in the credit and alt text for every photo.
- Do not paste passwords into stories or messages.
- Log out on shared computers.
- Do not share your account. The audit log records your name against every action.

### Who to call

Fill this in before training and print it.

| Problem | Contact | Phone / WhatsApp |
| --- | --- | --- |
| Cannot sign in, need a password reset, change of role or sections | Admin: ____________ | ____________ |
| Story questions, approvals, corrections | Your section editor: ____________ | ____________ |
| Anything about publishing policy, ads, redirects | Editor-in-chief: ____________ | ____________ |
| "Cannot reach the CMS", site is down, errors that will not clear | IT / technical contact: ____________ | ____________ |
| Suspected hacking or a lost phone or laptop | Admin and IT at once | ____________ |

When you report a problem, tell them: your name, what screen you were on, what you clicked, and the exact words of any red message. A screenshot helps.

---

## 11. Quick-reference cards

Cut out or print one per role.

### Card: Reporter

**Sign in:** newsroom address, email, password (12+ characters).
**Write:** **+ New Story** > headline, standfirst, section, body > **Save Draft** (Ctrl+S).
**Photos:** **Insert image** or **Choose or upload a photograph**. JPEG, PNG or WebP. Alt text and credit always.
**Send:** **Submit for Review**. Then wait.
**Sent back?** Read the editor's notes, fix, **Submit for Review** again.
**You cannot:** approve, publish, schedule, archive. Edit after it is In Review.
**Live:** post updates in **Live**. An editor approves them.
**Red banner (offline)?** Keep the tab open. Save when it clears.
**Stuck?** Your section editor. Sign-in trouble: the admin.

### Card: Trusted publisher

**Everything a reporter does, plus:**
**Publish your own story** in **your sections**: **Publish Story** or **Schedule** (set time, **Schedule**).
**Not allowed:** approving or publishing other people's work, or publishing outside your sections.
**Live:** manage events and approve updates in your sections.
**Corrections:** a published story needs a correction note when you change it.
**Remember:** the slug is locked after publishing.

### Card: Section editor

**Your sections only.**
**Queue:** **Review Queue** > **In Review** > **Inspect & Fact-Check**.
**Decide:** **Request Changes** (write notes) / **Approve Story** / **Publish Live**.
**Take down:** **Archive**. Not delete.
**Tips:** **Reader Tips & Submissions** > **Convert to Draft Story** or **Dismiss Tip** (give a reason).
**Archive Review (Alt+6):** check links, **Approve** or **Reject**. If you approved, a different editor publishes.
**Comments:** hide or restore old comments in the CMS admin.
**Live:** create events, **Go Live**, **End Coverage**, approve updates.
**Published story fix:** correction note required.

### Card: Editor-in-chief

**All sections.** Everything a section editor does, plus:
**Delete** a story (mistakes only).
**Change the slug** of a published story (a redirect is added for you).
**CMS admin:** Ads and advertisers, Redirects, Contact messages, Audit logs.
**Ads show only when** approved, paid or waived, and within dates.
**Redirects:** 301 moved, 302 temporary, 410 gone.
**Push notifications:** not switched on.
**Archive Review:** approve or reject. Then a different editor publishes.

### Card: Admin

**Everything the editor-in-chief does, plus:**
**Staff accounts:** CMS admin > **Users**. Set role. Set sections for section editors and trusted publishers.
**Password reset:** send a reset link (valid 1 hour). Lockout clears after 10 minutes.
**Newsletter subscribers:** view, mark unsubscribed or bounced.
**Archive review:** may approve and publish the same story.
**Delete** old comments (only admins).
**Audit logs:** check who did what.
**Keep safe:** never share admin logins. Remove accounts of people who leave.
