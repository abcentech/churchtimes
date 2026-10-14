import * as migration_20261013_134402_initial from './20261013_134402_initial';
import * as migration_20261013_140721_security_hardening from './20261013_140721_security_hardening';
import * as migration_20261013_145903_review_fixes from './20261013_145903_review_fixes';
import * as migration_20261014_203617_live_update_image from './20261014_203617_live_update_image';

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
    name: '20261014_203617_live_update_image'
  },
];
