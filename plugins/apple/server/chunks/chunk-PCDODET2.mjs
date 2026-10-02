import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// apps/apple/connectors/dist/apps/choice.js
var name = (row) => String(row.name);
var byId = (row) => String(row.id);
var accounts = (label) => ({
  stream: "accounts",
  scope: "accountIds",
  title: "accounts",
  id: byId,
  label
});
var collections = (stream, title) => ({
  stream,
  scope: "collectionIds",
  title,
  id: byId,
  label: (row, rows) => {
    const account = rows.get("accounts")?.find(({ id }) => id === row.accountId);
    return account === void 0 ? name(row) : `${name(account)} / ${name(row)}`;
  }
});

export {
  name,
  byId,
  accounts,
  collections
};
