# Apple Accounts

A user wants to know which accounts their Mac syncs through, and what each account syncs. macOS keeps these accounts in one Core Data store that accountsd writes. The Accounts source reads that store on this Mac. The Mail source reads its accounts through the same SDK. The words that all of elt uses, for example source, stream and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Account**:
One sign-in that an app of macOS syncs through, for example iCloud, a Google account or one of its children. An account can have a parent account.
_Avoid_: User, login, profile

**Account type**:
A kind of account, for example iCloud or Exchange. It names the data classes that an account of this type can offer and sync.
_Avoid_: Provider, service

**Data class**:
A kind of data that accounts sync, for example mail, calendars or contacts.
_Avoid_: Data type, category

**Account property**:
One keyed value of an account that the store keeps as a keyed archive, for example `IdentityEmailAddress`.
_Avoid_: Setting (the settings of a data class are on the account), attribute

**Access option key**:
An option key that an app gives when it asks for access to an account type.
_Avoid_: Permission, scope

**Authentication material**:
A property that signs in or proves an account, for example a nonce or an encrypted sign-in response. It does not load.
_Avoid_: Credential (a credential item is in the keychain), secret
