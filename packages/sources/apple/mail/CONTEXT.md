# Apple Mail source

A host wants the mail that Mail keeps on a Mac in a store that SQL can read: messages, their MIME parts and files, mailboxes, accounts and settings. The Mail source reads the files of Mail, and it does not start Mail. The words that all of elt uses, for example stream, snapshot stream, checkpoint and pass, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Mail store**:
The folder of Mail, `~/Library/Mail`. The `path` of the source names it.
_Avoid_: Mail library, Mail folder

**Version folder**:
The folder in the Mail store that holds the current layout, for example `V10`. `PersistenceInfo.plist` names it.
_Avoid_: Version directory

**Index**:
The SQLite database `MailData/Envelope Index` of the version folder. It lists the mailboxes, the messages and their relations.
_Avoid_: Envelope, database (the Accounts store is also a database)

**Message file**:
The `.emlx` file of one message: a byte count line, the MIME message, and a property list. A partial message file (`.partial.emlx`) does not hold all of its parts.
_Avoid_: Email, raw message, EMLX (as a noun for the message)

**Detached file**:
A file in an `Attachments` folder that holds one part of a partial message file.
_Avoid_: Download

**Indexed attachment**:
An attachment that the index lists. Its file can be on this Mac or not.
_Avoid_: Remote attachment

**Mailbox host**:
The host of a mailbox URL. It names the account of the mailbox.
_Avoid_: Account ID (the Accounts store has its own identifiers)

**Local row ID**:
`messages.id`, the row ID of a message in the index. The message streams join on it.
_Avoid_: Message ID (that is the hash)

**Message-ID hash**:
`messages.messageId`, Apple's hash of the RFC Message-ID. Global data, conversations and references join on it.
_Avoid_: Message ID

**Message group**:
The rows of one message in `messageFiles`, `messageHeaders`, `messageParts` and `attachments`. A pass reads a message again only when the fingerprint of its group changes.
_Avoid_: Batch

**Fingerprint**:
The value that tells whether a message group changed: the parser version, the relative path, size and modification time of each file of the message, and its rows in the attachment index. A copy of the Mail store keeps it.
_Avoid_: Version (of a file), hash

**File version**:
The full `stat` of a file: device, inode, size, and modification and change times in nanoseconds. The source checks it before and after each read of the file.
_Avoid_: Fingerprint

**Accounts store**:
The system database `~/Library/Accounts/Accounts4.sqlite`. It holds the account and server settings of Mail.
_Avoid_: Mail accounts, keychain
