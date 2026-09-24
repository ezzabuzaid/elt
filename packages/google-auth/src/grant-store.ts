import type { GoogleOAuthCredential } from './credential.ts';
import type { GoogleAccountGrant } from './grant.ts';

/**
 * Where grants live, as the host keeps them. The package reads `unknown` and
 * narrows with its own guard, so a store that also holds other credential
 * kinds conforms without a cast.
 */
export interface GoogleGrantStore {
  read(ref: string): Promise<unknown>;
  write(ref: string, credential: GoogleOAuthCredential): Promise<void>;
}

/** The on-disk shape of a user's `active.json`: which grant file is current. */
export interface GoogleActiveGrantPointer {
  readonly credentialRef: string;
}

/** The user's current grant and the ref it is stored under. */
export interface GoogleActiveGrant {
  readonly grant: GoogleAccountGrant;
  readonly ref: string;
}

/**
 * What `GoogleGrantVault` needs beyond a grant store: it also writes the
 * active pointer and removes one that points at nothing.
 */
export interface GoogleGrantVaultStore extends GoogleGrantStore {
  write(
    ref: string,
    value: GoogleOAuthCredential | GoogleActiveGrantPointer,
  ): Promise<void>;
  remove(ref: string): Promise<void>;
}
