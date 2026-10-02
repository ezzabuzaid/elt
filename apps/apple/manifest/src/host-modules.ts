import { registerHooks } from 'node:module';

// The modules a connector imports from its host, by specifier, with the file
// name a bundled host gives each one. The host resolves them to its own
// copies, so a connector's classes are the host's: the AppleApp it exports
// passes the host's checks, and its streams and records are the ones the
// host's elt runs.
export const hostModules = [
  { specifier: '@workspace/elt', file: 'elt' },
  { specifier: '@workspace/apple/apps/apple-app', file: 'apple-app' },
  { specifier: '@workspace/apple/apps/choice', file: 'choice' },
] as const;

export type HostModule = (typeof hostModules)[number];

// Resolves every host module a connector imports, for the rest of the
// process, to the URL the host gives for it.
export function provideHostModules(url: (module: HostModule) => string): void {
  const urls = new Map<string, string>(
    hostModules.map((module) => [module.specifier, url(module)]),
  );
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const provided = urls.get(specifier);
      return provided === undefined
        ? nextResolve(specifier, context)
        : { url: provided, shortCircuit: true };
    },
  });
}
