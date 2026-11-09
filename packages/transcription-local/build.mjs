import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const root = import.meta.dirname;
const dist = join(root, 'dist');
// Cargo's build cache is 362 MB, and dist holds what the package exports.
const target = join(root, 'node_modules/.cache/cargo');
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
    target,
  ],
  { stdio: 'inherit' },
);
copyFileSync(
  join(target, 'release/transcribe-local'),
  join(dist, 'transcribe-local'),
);
