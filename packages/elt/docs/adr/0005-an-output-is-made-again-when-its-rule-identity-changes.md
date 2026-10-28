# An output is made again when its rule identity changes

An output can become old in two ways. Its input can change, for example a listing gets a new description. Or what made it can change, for example the host selects a different speech model. pgai's vectorizer embeds its rows again after a change of the model.

Thus a rule gives a rule identity for each input, with `identity(input)`. For `DocumentText`, it is the parser of the format of the file. For `Embedding`, it is the provider and the id of the model. The computed dataset keeps the rule identity and a SHA-256 of the input with each output. A refresh makes an output again when one of the two changed.

The rule identity is for each input, not for the whole rule. A parser reads many formats. When the speech model changes, only audio files are read again, and the text of PDF, image and text files stays.

`identity(input)` gives `null` when the rule does not handle the input. Then an output that the rule made before stays, for example when a parser stops reading a format. A key with no output gets an empty output, with the rule identity `unsupported`.

## Considered Options

- **A version number that the caller increases.** A caller can forget it, and data that a refresh can make again needs no version.
- **One rule identity for the whole rule.** A change of one format then reads every file again.
- **A rule identity for each input.** This option was selected.

## Consequences

- A host that changes its speech model makes again only the text of audio files.
- A new parser or a new model makes again each output whose input it handles.
