# Staging phone checklist (real devices)

**Time:** about 15 minutes per phone.

**Phones:** run this once on an **Android phone in Chrome** and once on an **iPhone in Safari**. That is the "real Safari and physical phones" gap from #16, which the automated tests can't cover.

**Before you start**
- Staging is up (see `README.md`).
- You have the synthetic staff logins from the server: one **reporter** and one **section editor**. Never use real staff accounts.
- Use made-up content only: no real names, phone numbers or stories.
- Record a result for every row: ✅ works, ❌ broken (screenshot it), or ⚠️ works but awkward (one line on why).

**Phone:** ________  **Browser:** ________  **Date:** ________

## A. Public site: `https://staging.churchtimesnigeria.net`
| # | Do this | Expect | Result |
|---|---|---|---|
| A1 | Open the site | Loads over https (padlock), no browser warnings, readable without zooming | |
| A2 | Scroll the home page, open the menu, tap **Latest** | No sideways scrolling; the menu opens and closes | |
| A3 | Tap a story card | Article opens at `/reports/<name>/` with its photo | |
| A4 | Pull to refresh on that article | Still loads (no "not found") | |
| A5 | Tap the share button on the article | Link copied or the share sheet opens | |
| A6 | Rotate the phone to landscape and back | Layout adapts, nothing cut off | |

## B. Send a tip: public site, **Submit** page
| # | Do this | Expect | Result |
|---|---|---|---|
| B1 | Open **Submit** (share your story) | Form loads; the Cloudflare check box appears | |
| B2 | Submit with required fields empty | Clear error, nothing sent | |
| B3 | Fill in a made-up tip, complete the check, send | A receipt with a reference such as `SUB-…` | |
| B4 | Tap send again straight away with the same tip | Told it's a duplicate, no second receipt | |
| B5 | Typing on the phone keyboard | Fields aren't hidden behind the keyboard; you can scroll to the send button | |

Write down the receipt reference from B3: ________

## C. Newsroom as the **reporter**: `https://newsroom.staging.churchtimesnigeria.net`
| # | Do this | Expect | Result |
|---|---|---|---|
| C1 | Open the newsroom | Only the **Sign in** screen; no stories visible | |
| C2 | Sign in with a wrong password | Error shown, still signed out | |
| C3 | Sign in as the reporter | Dashboard with your name in the header | |
| C4 | New story: title, short summary, two paragraphs | Typing is comfortable; nothing overlaps | |
| C5 | **Choose or upload a photograph**: take a photo with the camera or pick one from the gallery | Upload works and the photo shows in the editor | |
| C6 | **Save Draft**, then **Submit for Review** | Success message; status "In review" | |
| C7 | Look for **Approve**, **Publish** or **Schedule** buttons | **None** visible for the reporter | |
| C8 | Open the review area that lists **Tips** | Says only editors can see tips | |
| C9 | **Log out** | Back to the Sign in screen | |

## D. Newsroom as the **section editor**
| # | Do this | Expect | Result |
|---|---|---|---|
| D1 | Sign in as the editor and open **Review** | The reporter's story is in the queue | |
| D2 | **Inspect & Fact-Check**, then **Approve Story**, then **Publish Story** | Each step confirms; status "Published" | |
| D3 | On the public site, open **Latest** | The story appears with its photo | |
| D4 | Back in the newsroom, edit the published story's text and save | Asks for a **correction note**; saves with one | |
| D5 | Reload the article on the public site | Corrected text plus "Corrections & updates" with your note | |
| D6 | Open **Tips** and find the receipt reference from B3 | The tip is there; convert it to a draft | |
| D7 | Check the converted draft on the public site | **Not** visible (it's only a draft) | |
| D8 | Optional: new story, approve, **Schedule** for 3 minutes ahead | Appears on the public site after about 3–4 minutes | |
| D9 | Optional: **Live**, then **+ New Event**, **Go Live**, post an update, **End Coverage** | Each step works on the phone | |
| D10 | Lock the phone for 5 minutes, unlock, keep working | Either still signed in, or a clear "sign in again" message; never a silent failure | |
| D11 | **Log out** | Back to the Sign in screen | |

## E. When you're done
- Send Claude Code the ❌ and ⚠️ rows with screenshots. Screenshots must not show passwords.
- Leave the test content where it is. The editor can archive it later, or the staging database gets wiped on teardown.
