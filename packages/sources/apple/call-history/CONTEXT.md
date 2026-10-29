# Apple Call History

A user wants the calls that they made and got, on the iPhone and on the Mac. callhistoryd keeps them in one Core Data store on this Mac, and fills it from the other devices of the user through iCloud. The Call History source reads that store. The words that all of elt uses, for example source, stream and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Call**:
One phone call or FaceTime call, from one row of `ZCALLRECORD`. `ZUNIQUE_ID` identifies it on each device that syncs it.
_Avoid_: Record, event

**Handle**:
An address of a party on a call, for example a phone number or an email address. callhistoryd keeps a separate handle for each call.
_Avoid_: Contact (a handle is not a contact), number

**Initiator**:
The handle of the party that started a call. `calls` carries it.
_Avoid_: Caller (the caller ID columns are a different thing), owner

**Participant**:
The handle of another party on a call. A group FaceTime call has more than one, and a withheld number has none.
_Avoid_: Contact, attendee

**Kind**:
Phone, FaceTime video or FaceTime audio, from the call type code that Apple names.
_Avoid_: Type (the raw code is `kindCode`), category (a category is audio or video)
