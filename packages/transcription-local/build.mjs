import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
execFileSync(
  'cargo',
  [
    'build',
    '--release',
    '--locked',
    '--manifest-path',
    join(root, 'native/Cargo.toml'),
    '--target-dir',
    join(dist, 'native'),
  ],
  { stdio: 'inherit' },
);
const release = join(dist, 'native/release');
copyFileSync(join(release, 'transcribe-local'), join(dist, 'transcribe-local'));
