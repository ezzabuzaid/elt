# Code copied from `@eltjs/embedding`

`Chunking` and `Embedding` read a loaded row in the same way: the value of `key` is the key, and the text of `fields`, joined with line breaks, is the input. A row with no key, or with no text in `fields`, has no input. This package keeps its own copy of that code, and does not share it with `@eltjs/embedding` yet.

The reason is the Rule of Three: the code that a second place needs is copied, and it is extracted only when a third place needs it (backlog #4896). Until then, a fix in one copy is made in the other copy too, and the commit names both files.

| `@eltjs/embedding`                      | `@eltjs/chunking`                       | What differs                                                                                |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- |
| `read()` in `src/embedding.ts`          | `read()` in `src/chunking.ts`           | Nothing                                                                                     |
| the `key` and `fields` of `constructor` | the `key` and `fields` of `constructor` | The description of the key column: "the chunks are cut from", not "the vector is made from" |
