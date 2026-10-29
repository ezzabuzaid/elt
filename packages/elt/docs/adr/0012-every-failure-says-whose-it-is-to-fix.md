# Every failure says whose it is to fix

elt recorded a failed pass only as the text of its message. Thus no host could tell an access failure from a different failure. The hosts added Full Disk Access guidance to each failure, also to a damaged Mail plist, a disk error or a bug (#2341).

Thus a failure has a type that the source decides, as the `failure_type` of Airbyte (`airbyte-python-cdk` `utils/traced_exception.py`). `Source.failureType(error)` returns `config` when the upstream refused what the user set up or granted, and `system` for each other error, also the errors of a destination. Each `LoadFailure` has its `failureType`, `RecordedPass.fail(error, failureType)` records it, and `passFailureType` gives a pass `config` when any failure is `config`. The two histories store `failure_type` on the attempts and in each failure of `extraction_coverage`.

## Considered Options

- **The hosts read the message text.** A host cannot tell an access failure from a bug.
- **The source classes each failure as `config` or `system`.** This option was selected.

## Consequences

- Hosts add access guidance only to a `config` failure.
- A watch loads again only a stream that failed for a `system` reason (ADR 0011).
- elt has no `transient_error`, because nothing reads it yet.
- A source lists its access errors in `configErrors`. It overrides `failureType` when the decision needs more than the class, as Search Console does for a `401` or `403` (elt ab3c5c30).

Sources: elt 929bba7b, ab3c5c30; backlog #2341.
