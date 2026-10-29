# Apple Notification Center

A user wants the notifications that their apps sent, also after Notification Center removed them. usernoted keeps each notification in one store for some minutes or days, and then deletes it with no record of why. The Notification Center source reads that store and keeps each notification that it saw. The words that all of elt uses, for example source, stream and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Notification**:
One delivery that Notification Center shows, from one row of `record`. The UUID of the delivery identifies it.
_Avoid_: Alert (an alert is a notification style), message, request

**Request**:
What an app asks Notification Center to show. The app gives it an identifier, `requestId`. A newer delivery of the same request replaces the older one in the store.
_Avoid_: Notification (a request can have more than one delivery)

**Category**:
A kind of notification that an app registers, with its buttons. An app registers all its categories as one list.
_Avoid_: Type, thread (a thread groups notifications)

**Action**:
One button that a category puts on its notifications, for example Reply.
_Avoid_: Button, command

**Withdrawal**:
The removal of a delivered notification by its app. Most notifications leave the store this way.
_Avoid_: Deletion (the store keeps no reason, so the source deletes nothing), dismissal (a dismissal is by the user)
