# One SDK reads Arab Bank's texts for every reader

Three readers parse Arab Bank's texts, each with its own copy of the templates: elt `apps/proactive` (EarlyMonthSpend and SpendSpike read the card purchase template, MissingMidMonthCredit the incoming transfer) and context-compiler `apps/ipay` (`src/rules/arab-bank-sms.ts`, 16 templates). The eca README holds a fourth copy of the purchase pattern as an example. The copies drifted: the proactive copies need `JOD ` with a space and read only the sender `Arab Bank`, so they missed 1,642 purchases that ipay reads (backlog #3668). This is the third place with the same knowledge, so the Rule of Three asks for one library. Ezz chose one parser on 2026-11-02 and kept it first on 2026-11-17.

The SDK lives in elt as `packages/sdks/arab-bank/sms`, `@eltjs/sdk-arab-bank-sms`. elt's AGENTS.md separates an SDK from a codec by one question: does the package know what the data means? This package knows that a template is a purchase or a salary, so it is an SDK, not a codec. It knows nothing of elt, so it carries `layer:sdk` and is an island.

## Considered Options

- **Each reader keeps its own copy (eca ADR 0004).** The copies already drifted, and the third reader would make a third copy.
- **zukhruf, as #3668 first said, because the readers are in two repositories.** zukhruf holds domain-free Node packages. The templates of one bank are domain knowledge, not a Node utility. context-compiler links `../elt` and already depends on elt's SDKs, so an elt package reaches both readers.
- **A codec in `packages/codecs`.** A codec knows only how bytes are laid out. This package knows what each text means.
- **A computed view, such as `bank_transactions`, in the warehouse.** The Messages connector cannot know each user's banks, and eca keeps no views (eca ADR 0004). A view can call this SDK later (elt #3186); the SDK comes first.
- **One SDK in elt.** This option was selected.

## Consequences

- eca ADR 0004 still holds for eca: eca keeps no views, and a condition parses its own data. The condition now calls this SDK in place of its own pattern. The migration adds a note to eca ADR 0004 and changes its README example.
- The `parser` export of ipay, a hash of the module's file, goes. A reader that must compute its data again when the parse changes reads the installed version of this package.
- A second bank, such as Safwa Bank, gets its own SDK. This package does not grow a list of banks.
