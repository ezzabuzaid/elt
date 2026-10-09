// Fails the commit when a staged file is not formatted. It reads each file as
// the index holds it, never the working tree, and changes nothing: other
// sessions edit this checkout at the same time, so formatting or staging the
// working tree's copy would commit their unstaged edits.
import { execFileSync } from 'node:child_process';
import { extname } from 'node:path';

import { check, getFileInfo, resolveConfig } from 'prettier';

const extensions = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
]);

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2 ** 30 });

const unformatted = [];
for (const path of git(
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
  '-z',
).split('\0')) {
  if (!extensions.has(extname(path))) continue;
  const { ignored } = await getFileInfo(path, {
    ignorePath: '.prettierignore',
  });
  if (ignored) continue;
  const options = await resolveConfig(path);
  try {
    if (!(await check(git('show', `:${path}`), { ...options, filepath: path })))
      unformatted.push(path);
  } catch (error) {
    unformatted.push(`${path} (${String(error).split('\n')[0]})`);
  }
}
if (unformatted.length > 0) {
  console.error(
    `These staged files are not formatted:\n${unformatted.join('\n')}\nFormat them with npx prettier --write and stage them again.`,
  );
  process.exit(1);
}
