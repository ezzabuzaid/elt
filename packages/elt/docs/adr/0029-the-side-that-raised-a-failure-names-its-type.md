# The side that raised a failure names its type

ADR 0012 let only the source name the failure type, and called each error of a destination `system`. Thus a destination could not say that a person must change its setup. The SQL Server destination refuses a database that keeps no row versions for readers, with the `ALTER DATABASE` statement to run (elt-sqlserver ADR 0010), and the sync history recorded that failure as `system`, which tells a host that a retry can help (#4736).

The checkpoint stores and the file storages had the same gap: a Postgres role that may not create `_warehouse._elt_checkpoints` recorded `system` (#4964).

Thus the `Destination`, `CheckpointStore` and `FileStorage` ports each have `failureType(error): FailureType`, as an Airbyte destination raises its own `config_error` (`AirbyteTracedException` with `failure_type`, `airbyte-python-cdk` `utils/traced_exception.py`). It is abstract: each side decides for its own errors, and no default decides for it.

The pipeline asks the side that raised the error. The destination names the type of each error that a call into it throws: its `load`, the `prepare` and the dispose of its `Load`, and each call of a `Stage`, also the `values` of a stage. The checkpoint store names the type of each error that it throws while it opens the checkpoints of a run, and while it reads or saves one of them. A file storage names the type of each error that its `save`, `flush` or `retain` throws; a read of the file content of the source inside a `save` stays the source's. The source names the type of each other error: its read, a message that breaks the contract, and each failure that ends a connection before a pass, such as a declaration that is not valid or a change signal that failed. The pipeline knows the side from where the error was thrown, not from the error itself: it wraps each call into a side, and the side names the type when the call throws.

## Considered Options

- **Only the source names the type (ADR 0012).** A destination's setup failure is `system`, and a watch retries it in vain.
- **The pipeline asks both sides, and takes `config` when one says `config`.** A destination that classifies by an error code could call an error of the source `config`. The answer depends on two classifiers for one error.
- **The side that raised the error names its type.** This option was selected.

## Consequences

- Each destination, checkpoint store and file storage implements `failureType`. A destination and the checkpoint store of its package write the same store, so they name the same errors. elt-sqlite calls a file that it cannot open (`UnavailableError` of `@zukhruf/sqlite-open`), a file that it may not write (SQLite `READONLY`, 8), a file that is not a database (`NOTADB`, 26) and a folder that it may not write (`EACCES`, `EPERM`, `EROFS`) `config`. elt-postgresql calls the SQLSTATE codes `42501`, `28P01`, `28000` and `3D000` `config`. elt-sqlserver calls `SqlServerSetupError`, `SqlServerPermissionError` and the server errors 229, 230 and 262 `config`. `LocalFiles` calls `EACCES`, `EPERM` and `EROFS` `config`. Each other error is `system`.
- A watch does not retry a stream that failed with a `config` error of its destination, its checkpoint store or a file storage.

Sources: backlogs #4736 and #4964; ADR 0012.
