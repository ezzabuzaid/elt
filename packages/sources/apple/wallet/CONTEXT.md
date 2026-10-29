# Apple Wallet

A user wants the passes in their Wallet in one store that SQL can read: boarding passes, tickets and reservations, with the fields that each pass shows. passd keeps the passes of this Mac in `~/Library/Passes`. The Wallet source reads that folder. The words that all of elt uses, for example source, stream and watch, are in the glossary of [elt](../../../elt/CONTEXT.md).

## Language

**Pass**:
One item in Wallet, for example a boarding pass or a ticket. The `unique_id` of passd identifies it on this Mac. The issuer identifies it by its pass type identifier and serial number.
_Avoid_: Card (a payment card is a different thing), ticket

**Issuer**:
The company that made and signed a pass, and that can update it.
_Avoid_: Vendor, organization (`organizationName` is a field of the pass)

**Bundle**:
The signed folder `Cards/<id>.pkpass/` of one pass: `pass.json`, `manifest.json`, the images and the localizations.
_Avoid_: Package, `.pkpass` file (Pass Viewer adds such a file, and passd keeps it as a folder)

**Field**:
One labelled value that a pass shows on its front or back, from an `<area>Fields` array of `pass.json`.
_Avoid_: Property, attribute

**Area**:
The part of a pass where a field shows: header, primary, secondary, auxiliary, back (behind the pass) or additionalInfo.
_Avoid_: Section, side

**Offset**:
The time zone offset in minutes that `pass.json` wrote a date with. The copies of passd lose it.
_Avoid_: Time zone (a pass gives only an offset)
