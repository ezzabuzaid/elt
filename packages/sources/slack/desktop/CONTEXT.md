# Slack desktop

A user wants the messages, conversations and files of their Slack workspaces in SQL, without a Slack token. The Slack desktop app keeps what it loaded in its own store on this Mac. The Slack desktop source reads that store. The words that all of elt uses, for example stream, copy and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Store**:
The IndexedDB of `https://app.slack.com` in the user data folder of the Slack app, with the app's own state in `storage/root-state.json`.
_Avoid_: Database (the store holds many IndexedDB databases), cache, export

**Build**:
One of the two Slack apps for macOS: the build from slack.com, or the Mac App Store build. Each build keeps its store in its own folder.
_Avoid_: Version, edition, installation

**Client record**:
The one record that the web client saves for each signed-in workspace: `persist:slack-client-<workspace>-<user>`. It holds the full Redux state of that workspace.
_Avoid_: Snapshot (the snapshot diff of elt has its own snapshot), dump, workspace record

**Save**:
One write of a client record into a new blob file. The app saves every few minutes while it runs, and when it quits.
_Avoid_: Sync, flush, commit (a commit is elt's)

**Held range**:
A range of a conversation's history that the client holds, from `channelHistory[channel].slices`. A read covers the held ranges, and only the held ranges.
_Avoid_: Slice (Slack's own word, used only for the raw shape), window, page

**Held message**:
A message that the app has loaded and still keeps in its client record.
_Avoid_: Cached message, synced message
