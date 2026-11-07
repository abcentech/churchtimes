# CI runner pin

Workflows run on `ubuntu-24.04`, not `ubuntu-latest`. On 2026-11-07 `ubuntu-latest` became Ubuntu 26.04, which Playwright 1.58.2 cannot install Chromium on (`npx playwright install --with-deps chromium` fails with "does not support chromium on ubuntu26.04-x64"), so every browser check failed. Move the pin forward only together with a Playwright upgrade that supports the new image.
