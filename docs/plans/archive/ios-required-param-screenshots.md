# iOS screenshots — required-param push views

> **Status: delivered 2026-04-28.**

## What shipped

Extended the synthesizer (`synthesizeSwiftValue` + `findStoredProperties`) to cover required-init-param push-nav views, not just `item:`-bound sheets:

- `findStoredProperties` now handles closure-type properties (`() -> Void`), `@Binding` params, and inline `//` comments on property declaration lines
- `synthesizeSwiftValue` now handles `() -> Void` → `{}` and `Binding<T>` → `.constant(synthesized T)`
- Both helper generators (`generateHelperFunction`, `generateSubHostHelperFunction`) now attempt synthesis for required-init-param views instead of always skipping them

`RemoveTrustedPersonCheckAnswersView` additionally required `@Binding var selectedReasons: Set<RemovalReason>` → synthesized as `selectedReasons: .constant([])`.

All five views in the `TrustedPersonDetailView` + `RemoveTrustedPerson*` chain now synthesize correctly and are captured in screenshots. Smoke test: nhsapp-ios-demo-v2 went from ~26 to ~31 screenshots after this fix.
