import type { Endpoint } from 'payload'

import { digestStaffEndpoints } from './newsletterDigestStaff'
import { newsletterOneClickEndpoints } from './newsletterOneClick'
import { shareCardEndpoints } from './publicShareCard'

/**
 * Agent E (growth) endpoints, registered with one line in payload.config.ts. See docs/w12/growth.md.
 * - RFC 8058 one-click unsubscribe (public, token-authenticated);
 * - daily digest staff tools: dry run and test send (editors/admins);
 * - share cards (Open Graph PNG), off unless SHARE_CARDS_ENABLED=true.
 */
export const growthEndpoints: Endpoint[] = [...newsletterOneClickEndpoints, ...digestStaffEndpoints, ...shareCardEndpoints]
