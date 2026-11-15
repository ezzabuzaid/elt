import type { Fields } from './fields.ts';
import type { TeamsAppDefinition, TeamsInstalledApp } from './teams-client.ts';

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
  store: string,
  { scope, scopeId }: AppScope,
): TeamsInstalledApp[] {
  const cacheKey = entitlements.requiredString('cacheKey');
  return entitlements.list('appEntitlements').flatMap((app, position) => {
    const state = app.requiredString('state');
    return state.startsWith('Installed')
      ? [
          {
            store,
            cacheKey,
            position,
            scope,
            scopeId,
            appId: app.requiredString('id'),
            state,
            version: app.string('installedVersion'),
            installedBy: app.string('installedBy'),
          },
        ]
      : [];
  });
}

// A definition the manager cached with no app in it defines nothing.
export function readAppDefinition(
  definition: Fields,
  store: string,
): TeamsAppDefinition | null {
  const item = definition.object('item');
  return item === null
    ? null
    : {
        store,
        cacheKey: definition.requiredString('cacheKey'),
        appId: definition.requiredString('appId'),
        version: item.string('version'),
        name: item.string('name'),
        developerName: item.string('developerName'),
      };
}
