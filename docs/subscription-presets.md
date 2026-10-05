# Subscription evidence presets

Mail's `mail_subscription_evidence`, Messages' `message_subscription_evidence` and Notes' `note_subscription_evidence` retrieve candidates using literal English and Arabic billing and lifecycle terms. Each has the same columns: `source`, `record_id`, `occurred_at`, `date_kind`, `correspondent`, `title`, `text`, `attachments`, `matched_terms` and `context`. Mail uses `mail_messages`, so load that preset first. Notes includes stored attachment OCR, summaries, handwriting and transcripts; Messages retains the handle's service and direction. Dates retain their source meaning: received mail, a Messages timestamp, or a note's modification time. None is an inferred renewal date. Attachment metadata retains identifiers for reading copied bytes separately, and works in imports without `attachmentRef`.

These presets retain offers, trials, cancellations, expired plans, outgoing records and one-off payments. They do not decide whether a subscription is active, merge plans or accounts, convert currencies, extract prices, parse PDF bytes or promise exhaustive recall. `matched_terms` explains why a record was retrieved, not confidence in a subscription. Reconcile the records before answering what is currently paid; retain sync and extraction coverage alongside that answer. There is no stored `subscriptions` dataset.

For one query across these connectors, open Mail read-only as `main`, attach the selected Messages and Notes imports as `sms` and `note_store`, and load `mail_messages` and `mail_subscription_evidence`. Load the other presets with their explicit `main.` qualifiers replaced by `sms.` and `note_store.` respectively; read their SQL and replace the qualifier before executing it on the same connection. The imports have identically named `messages` and `attachments` views, so loading unqualified SQL can read the wrong connector. The resulting temporary views can then be queried in one statement:

```sql
SELECT * FROM mail_subscription_evidence
UNION ALL SELECT * FROM message_subscription_evidence
UNION ALL SELECT * FROM note_subscription_evidence
ORDER BY occurred_at DESC, source, record_id;
```

For a single connector, the CLI already loads its presets before the statement, for example `query mail 'SELECT * FROM mail_subscription_evidence ORDER BY occurred_at DESC'`. Adding these SQL files requires no registry entry or import schema change; bundle the plugin with `nx run apple-plugin:bundle` to ship built-in presets. The cross-connector acceptance test in `subscription-presets.test.ts` loads the views through the macOS read-only SQLite shell, checks namespace collisions, multilingual and attachment-only candidates, lifecycle records, date meaning and unchanged database bytes. Its fixtures contain no personal data.
