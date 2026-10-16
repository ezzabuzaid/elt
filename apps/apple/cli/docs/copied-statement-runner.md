# Copied: the one-statement runner

`query()` and `holdsStatement()` run one read-only SQL statement and refuse a second one. They exist twice:

| Source                  | Copy                     | What changed                       | Why                                                                                       |
| ----------------------- | ------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `src/commands/query.ts` | `src/commands/people.ts` | The result type is written inline. | `people` is its own command beside `query`, and it reads the people model across imports. |

This is strike 2 of the Rule of Three. Do not extract a shared module yet.

- Mirror every fix in both copies, and name both files in the commit.
- Extract when a third command runs one statement (backlog item "Third one-statement command: extract the CLI's statement runner"). Then derive the shared part from the three copies, move it, and delete this file.
