import type { ExtractionCoverage } from '@workspace/elt';

// Every Apple source except Calendar exports its local store whole.
export const localAppleStoreCoverage: ExtractionCoverage = Object.freeze({
  description:
    'All records this stream can export from the accessible local Apple store, with no configured date filter. Local availability, permissions and source omissions still limit the export; it does not promise all cloud history. Attachment metadata may exist without retrievable file bytes.',
  selection: Object.freeze({}),
});
