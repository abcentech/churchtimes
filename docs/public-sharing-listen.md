# Sharing and on-device listening (Wave 2 B5)

## Sharing / Listen

The share dialog offers copy-link with readonly-input selection when the Clipboard API is denied or unavailable. Listen is progressive enhancement using only browser voices marked `localService`; it stays hidden when on-device speech is unavailable. Leaving the article cancels speech. No speech service or third-party script is loaded.


Browser speech transport is explicitly STUBBED in desktop/Pixel 7 tests; no audio/provider integration is claimed.

Review follow-up: voice availability is checked again on `voiceschanged`; an initially empty list keeps the control hidden until an on-device voice appears. The spoken clone excludes advertising slots/markers, sponsor labels, original-publication callouts, tags and controls. The button changes its label only, without duplicating the state in aria-pressed. Report sharing uses the canonical link and opening the dialog clears previous copy status. Optional local-speech code loads only on supported article routes.

Feature source only, depending on source-build policy #57; generated Pages assets are deferred to the dedicated integrated rebuild. The shared fieldset readiness correction is included explicitly.
