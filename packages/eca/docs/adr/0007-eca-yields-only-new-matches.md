# eca yields only new matches

The user asked: "when I spend over 200 in the first 10 days, do X". X happens at one moment: when the condition starts to match a key, for example October. An earlier design yielded three kinds of change, as alerting systems do: `started` when a key starts to match, `changed` when the data of a matched key changes, and `ended` when a key stops matching. Prometheus goes from inactive to firing, and Alertmanager sends resolved. Only `started` came from the request. `changed` and `ended` told the host things that it did not ask about.

Thus `watch` yields only new matches: a key that the condition matches now and did not match in the previous evaluation, with its rule and its data. A key that keeps matching gives nothing, also when its data changes. A key that stops matching gives nothing. When it matches again later, it is a new match again.

Each new match must say which rule matched, because one watch yields the matches of all the rules. A string id did that, and the host had to choose and keep it unique. The host already has the rule object that it added, so a new match carries that object.

## Considered Options

- **`started`, `changed` and `ended`, as alerting systems do.** Two of the three kinds were not in the request, and the host must sort them.
- **Only new matches.** This option was selected.
- **A rule has a string `id`, and a new match carries it.** The host must choose ids and keep them unique.
- **A new match carries the rule object.** This option was selected.

## Consequences

- A new match is `{ rule, key, data }`. It has no `type`.
- eca keeps only the keys of each rule, not their data, so it compares no data.
- The host does not hear that a month dropped under 200. When the month passes 200 again, the host hears of it again.
- The host tells the rules apart by identity, for example with `match.rule === spend`, or with a `Map` from rule to what to do.
