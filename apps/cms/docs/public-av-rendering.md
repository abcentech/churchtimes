# Public audio/video rendering

The public site renders the `audioVideo` block (contract v1.19) as native `<audio>`/`<video>` with `preload="none"`, using only `media.url` from the CMS media origin, and falls back to a plain link for a legacy `sourceUrl`.
