# Authentication material does not load

Some account properties sign in or prove an account: the encrypted last sign-in response of the iTunes Store (`lastAuthenticationServerResponse`), the next liveness nonce of the Apple ID (`nextLivenessNonce`), the opaque player record of Game Center (`GKPlayerInternal`), and `AuthID` in the `account-info` of the identity service. A reader of the destination does not need them, and a copy of them in the destination is a risk.

Thus `accountProperties` does not load the first three properties, and it loads `account-info` without `AuthID`. The description of `accountProperties` tells this. `credentialItems` loads only the expiry date of each credential, because the credential is in the keychain.

## Considered Options

- **Load every property.** The destination then holds material that signs in.
- **Leave out the authentication material.** This option was selected.

## Consequences

- On 2026-10-05, a load wrote 408 of 411 properties.
- The store holds no passwords, so the destination holds none.

Sources: commit 1dfd94dd.
