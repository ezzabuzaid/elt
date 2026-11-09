# Copied: the unit vector of `@zukhruf/embeddings`

`unitVector` in `src/embedding.ts` is a copy of `UnitVector.normalize` in `@zukhruf/embeddings` (`packages/embeddings/src/vector.ts` in zukhruf). Both make the vector that `VectorSearch` reads: a unit vector of float32 values in the byte order of the platform. That is the form that zukhruf's ADR 0005 sets.

|                                  | `UnitVector.normalize` | `unitVector`                                                                     |
| -------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| A length that is 0 or not finite | Throws a `RangeError`  | Gives the row a failed result, so that the other rows of the batch stay computed |
| The result                       | A `UnitVector`         | The bytes, in the result of a rule                                               |

This package does not import the class, because zukhruf does not export it. To get the class, this package would also have to depend on `sqlite-drift` and `sqlite-transaction`, which it does not use.

Until a third place needs this vector, make each fix in both copies and name both files in the commit. At the third place, move the code to one package and delete the copies.
