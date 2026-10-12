import type { Fields } from './fields.ts';
import type { TeamsInstalledApp } from './teams-client.ts';

// The client caches, for the user and for each chat and team, which apps are
// entitled there: its key names the scope, <Scope>_general_<locale>_<id>.
// Only an Installed... state is an installation; the others are the store's
// offers (NotInstalled, PreConsented, Featured, HiddenFromAppStore). A chat
// scope keyed default holds the tenant's defaults, not an installation.
const scopes = new Map([
  ['Personal', 'user'],
  ['GroupChat', 'chat'],
  ['Team', 'team'],
]);

type AppScope = { readonly scope: string; readonly scopeId: string };

export function readAppScope(entitlements: Fields): AppScope | null {
  const scope = scopes.get(
    entitlements.requiredString('cacheKey').split('_')[0] ?? '',
  );
  const scopeId = entitlements.requiredString('appEntitlementkey');
  return scope === undefined || scopeId === 'default'
    ? null
    : { scope, scopeId };
}

export function readInstalledApps(
  entitlements: Fields,
  { scope, scopeId }: AppScope,
  names: ReadonlyMap<string, Fields>,
): TeamsInstalledApp[] {
  return entitlements
    .list('appEntitlements')
    .filter((app) => app.requiredString('state').startsWith('Installed'))
    .map((app) => {
      const appId = app.requiredString('id');
      const definition = names.get(appId);
      return {
        scope,
        scopeId,
        appId,
        state: app.requiredString('state'),
        version: app.string('installedVersion'),
        installedBy: app.string('installedBy'),
        name: definition?.string('name') ?? null,
        developerName: definition?.string('developerName') ?? null,
      };
    });
}
