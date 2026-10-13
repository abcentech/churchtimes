import type { Endpoint } from 'payload'

// TODO(phase2): implement per apps/cms/docs/api-contracts.md
export const previewArticleEndpoint: Endpoint = {
  path: '/preview/articles',
  method: 'get',
  handler: async () =>
    Response.json(
      { ok: false, errors: [{ message: 'Not implemented.' }] },
      { status: 501 },
    ),
}
