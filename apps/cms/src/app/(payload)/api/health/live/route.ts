import { livenessResponse } from '../../../../../lib/health'

// No Payload import on purpose: liveness must not touch the database or the CMS boot.
export const dynamic = 'force-dynamic'

export const GET = () => livenessResponse('GET')
export const HEAD = () => livenessResponse('HEAD')
