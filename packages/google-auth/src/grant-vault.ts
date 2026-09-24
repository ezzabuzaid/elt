import { createHash } from 'node:crypto';
import { GoogleAccountGrant } from './grant.ts';
import type {
  GoogleActiveGrant,
  GoogleGrantVaultStore,
} from './grant-store.ts';

/**
 * Keeps one active grant per user. Layout under `directory`:
 * `<sha256(userId)>/accounts/<sha256(googleAccountId)>.json` holds each grant
 * the user completed, and `<sha256(userId)>/active.json` names the one in
 * use. Ids are hashed so the store's keys never carry an account id or a
 * user id in clear.
 */
export class GoogleGrantVault {
  readonly #directory: string;
  readonly #store: GoogleGrantVaultStore;

  constructor(options: {
    readonly directory: string;
    readonly store: GoogleGrantVaultStore;
  }) {
    this.#directory = options.directory;
    this.#store = options.store;
  }

  /**
   * The user's current grant. A pointer to a grant file that no longer
   * exists is removed and reported as no grant; a pointer or grant of the
   * wrong shape is an error, because it is not something the app wrote.
   */
  async active(userId: string): Promise<GoogleActiveGrant | undefined> {
    const userDirectory = this.#userDirectory(userId);
    const activeRef = `${userDirectory}/active.json`;
    const pointer = await this.#store.read(activeRef);
    if (pointer === undefined) return undefined;
    if (
      typeof pointer !== 'object' ||
      pointer === null ||
      !('credentialRef' in pointer) ||
      typeof pointer.credentialRef !== 'string' ||
      !pointer.credentialRef.startsWith(`${userDirectory}/accounts/`)
    ) {
      throw new Error('Stored Google grant selection has an invalid shape');
    }
    const stored = await this.#store.read(pointer.credentialRef);
    if (stored === undefined) {
      await this.#store.remove(activeRef);
      return undefined;
    }
    const grant = GoogleAccountGrant.parse(stored);
    if (!grant) throw new Error('Stored Google grant has an invalid shape');
    return { grant, ref: pointer.credentialRef };
  }

  /**
   * Stores the grant and makes it the user's active one. The grant file is
   * written before the pointer names it, so a crash between the two writes
   * leaves the previous selection intact instead of a pointer to nothing.
   */
  async save(userId: string, grant: GoogleAccountGrant): Promise<string> {
    const userDirectory = this.#userDirectory(userId);
    const ref = `${userDirectory}/accounts/${this.#digest(grant.account.id)}.json`;
    await this.#store.write(ref, grant.credential);
    await this.#store.write(`${userDirectory}/active.json`, {
      credentialRef: ref,
    });
    return ref;
  }

  #userDirectory(userId: string): string {
    return `${this.#directory}/${this.#digest(userId)}`;
  }

  #digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
