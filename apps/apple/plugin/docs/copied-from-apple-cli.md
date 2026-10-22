# Code copied from the Apple CLI

The Apple plugin and the Apple CLI both let one process at a time load an import, and both remove an import the selection no longer names. The plugin keeps its own copy of that code, and does not share it with `apps/apple/cli` yet.

The reason is the Rule of Three. It counts places, not packages. Code that a second place needs is copied, and it is extracted only when a third place needs it. The boundary of the shared code then comes from three working copies, not from a guess. The next host that loads Apple imports is the third place. When it comes, the shared parts move to one home (backlog #2555). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

Paths on the left are in `apps/apple/cli/src`. Paths on the right are in `apps/apple/plugin/src`.

## Copied without changes

**`imports.ts` `owners()` → `apple-plugin.ts` `owners()`.**
The import's owner claim: a `SqliteElection` whose claim and epoch files sit at the store's root, named after the import's folder.

## Copied with changes

**`imports.ts` `removeStale()` → `apple-plugin.ts` `ApplePlugin.#removeStale()`.**
Both remove a stale import only in its flight and only while they own it.

- The plugin's flight carries no lines, so its callback returns nothing.

Why: a plugin pass reports its outcome through the import's sync history, not through lines that a waiting sync shows.

## Not a copy

The CLI's `Imports.watch()` and the plugin's `ApplePlugin.watch()` both campaign for an import and then watch it, but they answer different needs. The CLI watches the connectors that one command names until the user stops it. The plugin follows the settings each second for the connectors the user keeps current, and gives an import up when the user switches it off or when another plugin version replaced its own.
