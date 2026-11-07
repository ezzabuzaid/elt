# Code copied from elt

`src/errors.ts` writes the message of a thrown value as `cause instanceof Error ? cause.message : String(cause)`. elt exports the same code as `errorMessage` (`packages/elt/src/state/sync-history.ts`). The package keeps its own copy and does not import it.

The reason is the direction of the dependencies. This package is an SDK, and the `layer:sdk` tag stops an SDK from depending on `@workspace/elt` (elt `AGENTS.md`, "SDKs"). The code is one expression, and a small helper in a package with a different set of dependencies stays copied. A fix to `errorMessage` that changes what it gives is made in this copy too, and the commit names both files.

## Copied with changes

**elt `errorMessage(error)` → `src/errors.ts` `PassBundleError`.**

- The expression is written in the message of `PassBundleError`, not in a function.
- It uses `instanceof Error`. elt uses `Error.isError`, which also knows an Error from another realm. A pass bundle is read in this realm, so the two give the same message.
