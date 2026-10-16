import { homedir } from 'node:os';
import { join } from 'node:path';

import { isDictionary, readPlist } from '@workspace/codec-plist';

export const globalPreferences = join(
  homedir(),
  'Library/Preferences/.GlobalPreferences.plist',
);

// The region picked in System Settings, as an ISO 3166 code such as JO: the
// country Contacts reads a number without a country code in. macOS keeps it
// in AppleLocale, as the locale's region (en_JO) or, when the region is not
// the language's, as an rg keyword (en_GB@rg=jozzzz). null when neither is
// set.
export async function macRegion(file: string): Promise<string | null> {
  const preferences = await readPlist(file);
  const locale = isDictionary(preferences) ? preferences.AppleLocale : null;
  if (typeof locale !== 'string') return null;
  const [base = '', keywords = ''] = locale.split('@');
  const override = /(?:^|;)rg=([a-z]{2})zzzz/i.exec(keywords)?.[1];
  if (override !== undefined) return override.toUpperCase();
  return new Intl.Locale(base.replaceAll('_', '-')).region ?? null;
}
