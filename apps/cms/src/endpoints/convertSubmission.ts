import type { Endpoint } from 'payload'

// TODO(phase2): implement per apps/cms/docs/api-contracts.md
export const convertSubmissionEndpoint: Endpoint = {
  path: '/:id/convert',
  method: 'post',
  handler: async () =>
    Response.json(
      { ok: false, errors: [{ message: 'Not implemented.' }] },
      { status: 501 },
    ),
}
