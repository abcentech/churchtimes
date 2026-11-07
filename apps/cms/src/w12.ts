import type { CollectionConfig, Endpoint, GlobalConfig } from 'payload'

import { Authors } from './collections/Authors'
import { Donations } from './collections/Donations'
import { NewsletterIssues } from './collections/NewsletterIssues'
import { Topics } from './collections/Topics'
import { publicNewsroomEndpoints } from './endpoints/publicNewsroom'
import { GivingSettings } from './globals/GivingSettings'
import { NewsletterSettings } from './globals/NewsletterSettings'
import { SiteTrust } from './globals/SiteTrust'

/**
 * Waves 1-2 schema (docs/w12/schema-contract.md), registered in payload.config.ts with one spread each so the shared config
 * file only changes by three lines. Schema is owned by one author (w12 plan section 3): other agents add their own endpoint
 * modules to payload.config.ts directly, never collections or globals.
 */
export const w12Collections: CollectionConfig[] = [Authors, Topics, Donations, NewsletterIssues]
export const w12Globals: GlobalConfig[] = [SiteTrust, GivingSettings, NewsletterSettings]
export const w12Endpoints: Endpoint[] = [...publicNewsroomEndpoints]
