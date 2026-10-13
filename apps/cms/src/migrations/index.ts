import * as migration_20261013_132506_initial from './20261013_132506_initial';

export const migrations = [
  {
    up: migration_20261013_132506_initial.up,
    down: migration_20261013_132506_initial.down,
    name: '20261013_132506_initial'
  },
];
