# Sharing and on-device listening (Wave 2 B5)

## Sharing / Listen

The share dialog offers copy-link with readonly-input selection when the Clipboard API is denied or unavailable. Listen is progressive enhancement using only browser voices marked `localService`; it stays hidden when on-device speech is unavailable. Leaving the article cancels speech. No speech service or third-party script is loaded.


Browser speech transport is explicitly STUBBED in desktop/Pixel 7 tests; no audio/provider integration is claimed.
