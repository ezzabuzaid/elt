# Microsoft Teams

A user wants the chats, channels, calls and meetings of their work or school Teams accounts in SQL, without Microsoft Graph or a token. The new Teams app keeps what it loaded in its own store on this Mac. The Teams source reads that store. The words that all of elt uses, for example stream, copy and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Store**:
The IndexedDB of `https://teams.microsoft.com` in the WebView profile `WV2Profile_tfw` of the Teams app's container.
_Avoid_: Database (the store holds many IndexedDB databases), cache, export

**Manager**:
A part of the Teams web client that keeps its own IndexedDB database for each account, for example `conversation-manager` or `replychain-manager`.
_Avoid_: Service, module, table

**Database set**:
All databases that the client keeps for one account and one locale, for example the databases whose names end in `:en-us`. A change of the app language starts a new database set.
_Avoid_: Profile (the WebView profile holds all sets), cache, locale

**Span**:
The part of a conversation, channel thread or feed that the client holds, from `syncstates`. A read covers the spans, and only the spans.
_Avoid_: Sync window (Teams' own word, used only for the raw fields), range (Slack's word), page

**Feed**:
A conversation of the client's own, such as `48:calllogs`, `48:notifications`, `48:annotations`, `48:saved` or `48:starred`. Call logs, activities and saved messages are the messages of feeds.
_Avoid_: Channel, stream (a stream is elt's)

**Account**:
A work or school account signed in to the app. Its ID is the user's Entra object ID, `accountId`.
_Avoid_: User, tenant (an account belongs to a tenant), workspace
