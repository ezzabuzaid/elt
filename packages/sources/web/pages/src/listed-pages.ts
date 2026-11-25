import {
  DeletionPolicy,
  type VanishedRecord,
  type Verdict,
} from '@zukhruf/snapshot-differential';

/**
 * Each page is a partition of its web stream, as a dlt merge_key is: a key
 * that vanished from a page the scan listed, read again or gone, is deleted,
 * and a key of a page the scan did not list expires, because a page that left
 * its listings can still exist (ADR 0005, ADR 0019).
 */
export class ListedPages extends DeletionPolicy {
  override vanished({ group }: VanishedRecord): Verdict {
    return group?.listed === true ? 'deleted' : 'expired';
  }
}
