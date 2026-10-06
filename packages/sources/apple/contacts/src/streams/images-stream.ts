import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import type { FieldSchema } from '@workspace/elt';
import type {
  AddressBookStore,
  ContactImagesRow,
  StoredData,
} from '@workspace/sdk-apple-contacts';
import { eventKitFields } from '@workspace/source-apple-macos/eventkit-fields';

import { AppleContactsStream } from '../apple-contacts-stream.ts';
import { localStores } from '../contacts-fields.ts';
import {
  type ContactSelection,
  type ContactsScan,
  imageKey,
} from '../contacts-scan.ts';

const { id, text, nullableText } = eventKitFields;

async function sha256(data: StoredData): Promise<string> {
  const hash = createHash('sha256');
  if (data.storage === 'inline') hash.update(data.bytes);
  else
    for await (const chunk of createReadStream(data.path)) hash.update(chunk);
  return hash.digest('hex');
}

const properties = {
  contactId: {
    ...id,
    description:
      'Contact identifier, AddressBook ZABCDRECORD.ZUNIQUEID; refers to contacts.id within this source. Part of the primary key with kind.',
  },
  kind: {
    ...text,
    enum: ['image', 'thumbnail'],
    description:
      'Which stored image this row is: image for ZABCDRECORD.ZIMAGEDATA, thumbnail for ZABCDRECORD.ZTHUMBNAILIMAGEDATA. Part of the primary key with contactId.',
  },
  storage: {
    ...text,
    enum: ['inline', 'external'],
    description:
      "Where Contacts keeps the bytes in its own store: inline inside the database column, or external in a file under the store's .AddressBook-v22_SUPPORT/_EXTERNAL_DATA directory. It describes the native source, not an exported file.",
  },
  externalId: {
    ...nullableText,
    description:
      "Contacts' storage identifier for external bytes: the file name under .AddressBook-v22_SUPPORT/_EXTERNAL_DATA recorded in the column. NULL when storage is inline. It is not an exported file.",
  },
  byteLength: {
    type: 'integer',
    minimum: 0,
    description:
      'Size in bytes of the stored image: the inline bytes after the storage marker, or the external file. Computed by this connector at extraction.',
  },
  sha256: {
    ...text,
    description:
      'Lowercase hexadecimal SHA-256 of the same bytes byteLength counts, computed by this connector at extraction.',
  },
} satisfies Record<string, FieldSchema>;

// A contact's photo and thumbnail, each inline or in _EXTERNAL_DATA.
export class ImagesStream extends AppleContactsStream<ContactImagesRow> {
  readonly name = 'images';
  readonly primaryKey = ['contactId', 'kind'];
  readonly supportsFileTransfer = true;
  readonly jsonSchema = {
    type: 'object',
    description: `One row per stored contact image, from AddressBook ZABCDRECORD.ZIMAGEDATA (kind image) and ZTHUMBNAILIMAGEDATA (kind thumbnail): at most two rows per contact. Primary key (contactId, kind); contactId refers to contacts.id. byteLength and sha256 are computed from the bytes when extracted; a stored external file that cannot be read fails the extraction instead of producing a row. ${localStores}`,
    properties,
    required: Object.keys(properties),
  } as const;

  protected rows(store: AddressBookStore): readonly ContactImagesRow[] {
    return store.images();
  }

  protected accepts(
    row: ContactImagesRow,
    selection: ContactSelection,
  ): boolean {
    return selection.contact(row.contactId);
  }

  // The stored data stays in the scan, for the files the read hands over.
  protected async records(
    row: ContactImagesRow,
    _store: AddressBookStore,
    scan: ContactsScan,
  ): Promise<Record<string, unknown>[]> {
    const records: Record<string, unknown>[] = [];
    for (const kind of ['image', 'thumbnail'] as const) {
      const data = row[kind]();
      if (data === null) continue;
      scan.images.set(imageKey(row.contactId, kind), data);
      records.push({
        contactId: row.contactId,
        kind,
        storage: data.storage,
        externalId: data.storage === 'external' ? data.id : null,
        byteLength:
          data.storage === 'inline'
            ? data.bytes.length
            : (await stat(data.path)).size,
        sha256: await sha256(data),
      });
    }
    return records;
  }
}
