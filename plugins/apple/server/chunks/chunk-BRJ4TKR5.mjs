import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// packages/sources/apple/macos/dist/local-apple-store-coverage.js
var localAppleStoreCoverage = Object.freeze({
  description: "All records this stream can export from the accessible local Apple store, with no configured date filter. Local availability, permissions and source omissions still limit the export; it does not promise all cloud history. Attachment metadata may exist without retrievable file bytes.",
  selection: Object.freeze({})
});

export {
  localAppleStoreCoverage
};
