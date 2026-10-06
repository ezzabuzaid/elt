import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// packages/sources/apple/macos/dist/import-scope.js
function selected(ids, id) {
  return ids === void 0 || typeof id === "string" && ids.includes(id);
}
function withinDates(scope, value) {
  if (scope.startAt === void 0 && scope.endAt === void 0)
    return true;
  return typeof value === "string" && (scope.startAt === void 0 || value >= scope.startAt) && (scope.endAt === void 0 || value < scope.endAt);
}

export {
  selected,
  withinDates
};
