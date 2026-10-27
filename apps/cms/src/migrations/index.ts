import * as migration_20261013_134402_initial from './20261013_134402_initial';
import * as migration_20261013_140721_security_hardening from './20261013_140721_security_hardening';
import * as migration_20261013_145903_review_fixes from './20261013_145903_review_fixes';
import * as migration_20261014_203617_live_update_image from './20261014_203617_live_update_image';
import * as migration_20261014_211527_article_body_media from './20261014_211527_article_body_media';
import * as migration_20261014_221500_live_events_started_at_backfill from './20261014_221500_live_events_started_at_backfill';
import * as migration_20261016_094708_article_seo_fields from './20261016_094708_article_seo_fields';
import * as migration_20261016_110618_media_legacy_path from './20261016_110618_media_legacy_path';
import * as migration_20261017_095306_redirects from './20261017_095306_redirects';
import * as migration_20261019_215623_contact_and_newsletter from './20261019_215623_contact_and_newsletter';
import * as migration_20261019_230557_legacy_comments from './20261019_230557_legacy_comments';
import * as migration_20261020_144045_ad_campaigns from './20261020_144045_ad_campaigns';
import * as migration_20261021_100000_article_legacy_id_unique from './20261021_100000_article_legacy_id_unique';
import * as migration_20261021_110000_submission_consent from './20261021_110000_submission_consent';
import * as migration_20261022_125053_audit_actor_snapshot from './20261022_125053_audit_actor_snapshot';
import * as migration_20261022_141856_article_list_index from './20261022_141856_article_list_index';
import * as migration_20261023_090000_article_search from './20261023_090000_article_search';
import * as migration_20261023_143703_archive_candidate_provenance from './20261023_143703_archive_candidate_provenance';
import * as migration_20261027_115905_article_multi_category from './20261027_115905_article_multi_category';

export const migrations = [
  {
    up: migration_20261013_134402_initial.up,
    down: migration_20261013_134402_initial.down,
    name: '20261013_134402_initial',
  },
  {
    up: migration_20261013_140721_security_hardening.up,
    down: migration_20261013_140721_security_hardening.down,
    name: '20261013_140721_security_hardening',
  },
  {
    up: migration_20261013_145903_review_fixes.up,
    down: migration_20261013_145903_review_fixes.down,
    name: '20261013_145903_review_fixes',
  },
  {
    up: migration_20261014_203617_live_update_image.up,
    down: migration_20261014_203617_live_update_image.down,
    name: '20261014_203617_live_update_image',
  },
  {
    up: migration_20261014_211527_article_body_media.up,
    down: migration_20261014_211527_article_body_media.down,
    name: '20261014_211527_article_body_media',
  },
  {
    up: migration_20261014_221500_live_events_started_at_backfill.up,
    down: migration_20261014_221500_live_events_started_at_backfill.down,
    name: '20261014_221500_live_events_started_at_backfill',
  },
  {
    up: migration_20261016_094708_article_seo_fields.up,
    down: migration_20261016_094708_article_seo_fields.down,
    name: '20261016_094708_article_seo_fields',
  },
  {
    up: migration_20261016_110618_media_legacy_path.up,
    down: migration_20261016_110618_media_legacy_path.down,
    name: '20261016_110618_media_legacy_path',
  },
  {
    up: migration_20261017_095306_redirects.up,
    down: migration_20261017_095306_redirects.down,
    name: '20261017_095306_redirects',
  },
  {
    up: migration_20261019_215623_contact_and_newsletter.up,
    down: migration_20261019_215623_contact_and_newsletter.down,
    name: '20261019_215623_contact_and_newsletter',
  },
  {
    up: migration_20261019_230557_legacy_comments.up,
    down: migration_20261019_230557_legacy_comments.down,
    name: '20261019_230557_legacy_comments',
  },
  {
    up: migration_20261020_144045_ad_campaigns.up,
    down: migration_20261020_144045_ad_campaigns.down,
    name: '20261020_144045_ad_campaigns',
  },
  {
    up: migration_20261021_100000_article_legacy_id_unique.up,
    down: migration_20261021_100000_article_legacy_id_unique.down,
    name: '20261021_100000_article_legacy_id_unique',
  },
  {
    up: migration_20261021_110000_submission_consent.up,
    down: migration_20261021_110000_submission_consent.down,
    name: '20261021_110000_submission_consent',
  },
  {
    up: migration_20261022_125053_audit_actor_snapshot.up,
    down: migration_20261022_125053_audit_actor_snapshot.down,
    name: '20261022_125053_audit_actor_snapshot',
  },
  {
    up: migration_20261022_141856_article_list_index.up,
    down: migration_20261022_141856_article_list_index.down,
    name: '20261022_141856_article_list_index',
  },
  {
    up: migration_20261023_090000_article_search.up,
    down: migration_20261023_090000_article_search.down,
    name: '20261023_090000_article_search',
  },
  {
    up: migration_20261023_143703_archive_candidate_provenance.up,
    down: migration_20261023_143703_archive_candidate_provenance.down,
    name: '20261023_143703_archive_candidate_provenance',
  },
  {
    up: migration_20261027_115905_article_multi_category.up,
    down: migration_20261027_115905_article_multi_category.down,
    name: '20261027_115905_article_multi_category'
  },
];
