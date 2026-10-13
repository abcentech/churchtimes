import * as migration_20261013_134402_initial from './20261013_134402_initial';
import * as migration_20261013_140721_security_hardening from './20261013_140721_security_hardening';

export const migrations = [
  {
    up: migration_20261013_134402_initial.up,
    down: migration_20261013_134402_initial.down,
    name: '20261013_134402_initial',
  },
  {
    up: migration_20261013_140721_security_hardening.up,
    down: migration_20261013_140721_security_hardening.down,
    name: '20261013_140721_security_hardening'
  },
];
