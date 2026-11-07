# Public search: misleading "0 stories found" above CMS results

On the public site, `#search/<term>` rendered the bundled edition's local filter first
("N stories found" or "No matching stories.") and the live CMS results in a separate
"Published newsroom search" block below it. When the CMS was configured and the term matched
nothing in the small bundled sample, readers saw "0 stories found / No matching stories."
above a list of real hits, which looked like search returning nothing.

The search request itself was healthy (`/api/public/search` returned 200 with hits).

Fix: when a CMS URL is configured and the local sample has no match, the local count and empty
state are not rendered; the CMS block is the only result area. With no CMS configured, the
original empty state is unchanged.
