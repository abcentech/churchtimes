# Newsroom accessibility checks

The staff newsroom SPA (`apps/newsroom`) has an automated accessibility suite: `tests/newsroom-a11y.spec.js`, run in the
`newsroom` CI job (`.github/workflows/newsroom.yml`) through `npm run test:newsroom-app`.

- axe-core with the `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and `best-practice` tags on every newsroom screen and state,
  on desktop and mobile viewports. Serious and critical violations fail CI; minor ones are reported as annotations.
- Keyboard-only checks (skip link, tab order, visible focus, modal focus trap and restore, Escape), aria-live announcements,
  form labels, reduced motion and reflow at 320px.
- Exceptions are only allowed in the explicit `A11Y_ALLOWLIST` in the spec, each with a reason (currently none).

Operational note: the CMS admin (Payload) is not covered by this suite; review it separately when upgrading Payload.
See `apps/newsroom/README.md` for how to run it locally.
