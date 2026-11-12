# Brand masthead

The official Church Times Nigeria masthead (black "Church", red cross-shaped "T", green "imes", "NIGERIA" between two rules) is used everywhere the name appears.

| File | Used by |
| --- | --- |
| `public/brand-assets/masthead.svg` | Public site header and footer, light theme (every page, including articles) |
| `public/brand-assets/masthead-dark.svg` | Public site, dark theme. Same artwork with light lettering and a lighter green so it reads on the dark background |
| `public/favicon.svg`, `apps/newsroom/public/favicon.svg`, `apps/cms/public/brand/icon.svg` | Browser tab icon: the red cross "T" on an ivory square |
| `apps/newsroom/public/masthead-dark.svg` | Newsroom app header (dark bar) |
| `apps/cms/public/brand/masthead*.svg` | CMS admin login screen (follows the admin's light or dark theme) and the admin navigation icon |

The master file is `public/brand-assets/masthead.svg` (transparent background). The other files are copies or colour variants of it. To change the logo, replace the master and regenerate the variants the same way: dark = `#030303` to `#F1EFE8` and `#007052` to `#4CC59B`; icon = the red `#CC2330` path alone on `#FAFBF8`.

Each masthead file is about 4.4 KB gzipped. It is an image, so it does not count against the reader JavaScript budget.
