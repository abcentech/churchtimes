# Public main-shell fixes

The public shell now searches through the C8 endpoint `GET /api/public/search` (not `where[or]` on `/api/articles`), so search needs `PUBLIC_SUBMISSION_ORIGINS` to include the public origin and `npm run search:reindex` to have run once on the target CMS.
