# iOS item:-bound sheet screenshots

## Problem

The iOS screenshot pipeline currently skips `.sheet(item: $stateVar)` and
`.fullScreenCover(item: $stateVar)` modifiers. These are excluded because
setting the binding to `true` (the `isPresented:` approach) doesn't type-check
— the binding holds an `Optional<T>`, not a `Bool`.

In `nhsapp-ios-demo-v2`, the affected screens are:

| Parent view | Binding | Destination view |
|---|---|---|
| `AppointmentsView` | `$selectedAppointment: Appointment?` | `AppointmentDetailView(appointment:)` |
| `GPAppointmentsView` | `$selectedAppointment: Appointment?` | `AppointmentDetailView(appointment:)` |

These are real screens in the user journey that appear in the graph with no
screenshot. The fix is to synthesize a default `T` value at injection time and
set `selectedAppointment = <synthesized Appointment>` in the parent view's
`.task`.

## Approach

Extend `swift-injector.js` with a type synthesizer that:

1. **Finds the binding type** — given `$selectedAppointment`, reads the
   `@State var selectedAppointment: Appointment?` declaration in the parent
   view to extract `Appointment` as the item type.

2. **Locates the struct definition** — globs for `Appointment.swift` (or
   searches all Swift files for `struct Appointment`) to find the stored
   property declarations.

3. **Generates a default initializer call** — maps each stored property to a
   type-appropriate Swift literal:

   | Swift type | Default value |
   |---|---|
   | `String` | `""` |
   | `Int` / `Int32` / `Int64` | `0` |
   | `Double` / `Float` | `0.0` |
   | `Bool` | `false` |
   | `Date` | `Date()` |
   | `UUID` | `UUID()` |
   | `URL` | `URL(string: "https://example.com")!` |
   | `[T]` (any array) | `[]` |
   | `T?` (any optional) | `nil` |
   | Custom struct | recurse (depth-limited to 3) |
   | Enum | first case from definition, or `.init(rawValue: 0)!` |
   | Unknown | skip property (omit from call; relies on default param or memberwise) |

4. **Injects the synthesized value** — the parent view's `.task` sets:
   ```swift
   case "AppointmentDetailView": selectedAppointment = Appointment(id: UUID(), date: Date(), ...)
   ```

5. **Falls back gracefully** — if the type can't be synthesized (missing
   definition, class not struct, required custom init), logs a warning and
   leaves the sheet excluded rather than generating code that won't compile.

## Implementation plan

### Step 1 — extend `resolveSheetStateVars` to handle `item:` bindings

Currently the function only matches `isPresented:`. Add a second pass that:
- Matches `.sheet(item: $<var>)` / `.fullScreenCover(item: $<var>)`
- Extracts `stateVarName` → looks up `@State var <stateVarName>: <T>?` in the
  file content to get type `T`
- Records `{ stateVar, itemType: T, routeSegment, routeFull, parentViewName }`

Mark item-bound triggers differently (e.g. `kind: "item"` vs `kind: "bool"`).

### Step 2 — write `synthesizeSwiftValue(typeName, prototypePath, depth = 0)`

New function (pure JS, no side effects). Returns a Swift expression string or
`null` if synthesis fails.

```
synthesizeSwiftValue(typeName, prototypePath, depth):
  if depth > 3 → return null   // guard against infinite recursion

  primitives: String → '""', Int → '0', Double → '0.0', Bool → 'false',
              Date → 'Date()', UUID → 'UUID()',
              URL → 'URL(string: "https://example.com")!'

  T? → 'nil'
  [T] → '[]'
  Set<T> → '[]'   (Swift accepts array literal for Set)

  custom type:
    - glob for struct definition in prototypePath
    - parse stored properties (let/var lines before first func/var body/init)
    - for each prop: synthesize value recursively
    - if any non-optional prop returns null → return null (can't build safe call)
    - return 'TypeName(prop1: val1, prop2: val2, ...)'
    - omit optional props from call entirely (memberwise init supplies nil)
```

### Step 3 — extend `generateSheetTriggerTask` to emit item assignments

When a trigger has `kind: "item"`, emit:
```swift
case "AppointmentDetailView":
    selectedAppointment = Appointment(id: UUID(), date: Date(), ...)
```
instead of:
```swift
case "AppointmentDetailView": selectedAppointment = true
```

If synthesis returned `null` for a trigger, omit that case entirely and log a
warning (so the build doesn't break).

### Step 4 — smoke test

Run against `nhsapp-ios-demo-v2`. Expect:
- `AppointmentDetailView.png` to show a real appointment detail screen (not
  empty)
- Build succeeds (no type errors from synthesized init calls)
- No regression on the 23 previously-captured screenshots

## Files changed

- `src/swift-injector.js` — all changes (synthesizer + resolver + generator)

## Known edge cases

- **Class types**: only structs get memberwise inits. Classes need a designated
  init; synthesis returns null and the screen is skipped.
- **Enums as item type**: uncommon for sheets but possible. Fall back to null
  for now (can add case-extraction later).
- **Types with a required custom `init`**: if the struct has private stored
  properties or a custom init that doesn't match the memberwise shape,
  synthesized call won't compile. Synthesis returns null → skipped.
- **Same destination from multiple parents**: `AppointmentDetailView` is
  opened from both `AppointmentsView` and `GPAppointmentsView`. Both get
  injected; both need the same synthesized `Appointment`. This is fine —
  synthesis is deterministic.
- **Nested custom types**: e.g. if `Appointment` has a `Doctor` field and
  `Doctor` has a `Clinic` field — recursion handles this up to depth 3, then
  gives up and treats the field as skipped.
