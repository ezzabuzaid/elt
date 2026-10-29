# WhatsApp desktop

A user wants their WhatsApp chats, messages, calls and contacts in SQL, without a WhatsApp session. WhatsApp for Mac keeps them in its own SQLite stores on this Mac. The WhatsApp desktop source reads those stores. The words that all of elt uses, for example stream, copy and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Group container**:
The folder `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared`, which WhatsApp shares with its extensions. It holds the stores and the media files.
_Avoid_: Container (the app has a separate sandbox container), app folder

**Store**:
One SQLite database of WhatsApp in the group container, for example `ChatStorage.sqlite`. Each store opens, fails and wakes a watch separately.
_Avoid_: Database (in a sentence about the warehouse), file, table

**JID**:
The name that WhatsApp gives a person, group or channel: `<number>@s.whatsapp.net`, `<LID>@lid`, `…@g.us` or `…@newsletter`.
_Avoid_: ID, phone number, handle

**LID**:
A number that WhatsApp gives a person in place of the phone number. `users` maps it to the phone number when the person shares it.
_Avoid_: User ID, alias

**Stanza ID**:
The ID that the sender of a message gives it. With the chat's JID and whether this account sent it, it is the key of a message.
_Avoid_: Message ID (ambiguous with the Core Data row number)

**Media item**:
The row of `ZWAMEDIAITEM` that a message carries. It holds different things for different kinds of message: a file, a link preview, a contact card or a place.
_Avoid_: Attachment (an attachment is a stored file of elt), media

**Status**:
A post that a contact or the account shares for one day. WhatsApp removes a contact's status one day after it is posted.
_Avoid_: Story, message status (a message's delivery state is `status` in `messages`)
