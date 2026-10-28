# A watch refreshes in the background, one refresh at a time

A refresh can be slow. For example, the text of many images needs one OCR read for each image. The host before this change first waited for each refresh in its watch loop. That stopped every connection: the watch makes the next pass only after the host took the last one. One slow file then held all new rows back. This is head-of-line blocking.

Thus a watch refreshes its derived datasets in the background. After each pass, the watch asks for a refresh, and it gives the pass to the host at once. One refresh runs at a time. A pass that commits while a refresh runs asks for one more refresh after it, and more passes in that time ask for no more than that one. A build watcher keeps one rebuild in its queue in the same way. A dataset failure stops the watch. A refresh that the stop of the watch ended is not a failure.

## Considered Options

- **The watch waits for each refresh before it gives the pass.** One slow file then holds back every connection.
- **Each pass starts its own refresh.** Two refreshes then compute the same inputs, for example they read one file two times.
- **One refresh at a time, with one more refresh in the queue.** This option was selected.

## Consequences

- A reader can see the rows of a pass before their derived data. The next refresh gives that data.
- When the watch stops, it waits until the refresh that runs ends.
- The test `under a watch, a file that is slow to read holds no pass back` of `elt-sqlite` proves this rule.
