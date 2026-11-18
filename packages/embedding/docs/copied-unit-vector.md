# Copied: the unit vector of `@zukhruf/vectors`

`unitVector` in `src/embedding.ts` divides each value of the model's vector by its length, as `UnitVector.normalize` of `@zukhruf/vectors` does. Both make the vector that `VectorSearch` of `@zukhruf/embeddings` reads: a unit vector of float32 values in the byte order of the platform. That is the form that zukhruf's ADR 0005 sets. The bytes come from `toSql` of `@zukhruf/vectors/sqlite`; only the division is a copy.

|                                  | `UnitVector.normalize`                                             | `unitVector`                                                                     |
| -------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| The division                     | Rounds the values to float32 first, then divides                   | Divides the float64 values, then rounds to float32                               |
| A length that is 0 or not finite | Throws a `ZeroVectorError`, or `Vector.from` throws a `RangeError` | Gives the row a failed result, so that the other rows of the batch stay computed |
| The result                       | A `UnitVector`                                                     | The bytes, in the result of a rule                                               |

The two divisions give other last bits: on 1,000 pseudo-random vectors of 384 dimensions, 963 differ in at least one byte. So this package keeps its own division until zukhruf #4694 settles which division `UnitVector.normalize` makes. Then move `unitVector` onto `UnitVector.normalize` and delete this file.

Until then, make each fix in both copies and name both files in the commit.
