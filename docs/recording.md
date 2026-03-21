# Recording scenarios

The recorder lets you create `.flow` scenario files by clicking through your prototype in a real browser, instead of writing them by hand.

## Quick start

```bash
flow-map --record ~/Repos/my-prototype
```

This opens a headed browser with your prototype and a floating toolbar at the top of the page. Click through your prototype naturally — every interaction is captured as a `.flow` step.

## How it works

1. The prototype server starts and a browser window opens
2. You interact with the prototype while the recorder captures your actions
3. Steps are printed to the terminal in real-time
4. When you're done, the recorder writes a `.flow` file to `scenarios/`

## The toolbar

A coloured bar appears at the top of every page:

- **Phase indicator** — shows "SETUP" (orange) or "MAP" (green)
- **Step counter** — how many steps have been recorded
- **Begin mapping** — transitions from Setup to Map phase (disappears after clicking)
- **Capture page** — forces a `Snapshot` step for the current page
- **Finish** — ends recording and saves the file

## Phases

### Setup phase (orange)

Everything you do before clicking "Begin mapping" becomes a Setup step. Use this for authentication, selecting a user, or navigating to a starting point.

Navigations in setup become `Goto` steps.

### Map phase (green)

After clicking "Begin mapping", your interactions are recorded as Map steps. Page navigations automatically generate `Visit` steps (deduplicated).

## What gets captured

| Interaction | Step type |
|---|---|
| Click a link | `ClickLink "text"` (or `Click` with selector if no accessible name) |
| Click a button | `ClickButton "text"` (or `Click` with selector) |
| Select a radio button | `Choose "label"` |
| Tick a checkbox | `Check "label"` |
| Fill in a text field | `FillIn "label" with "value"` (or `Fill` with selector) |
| Select from a dropdown | `Select "option" from "label"` (or `Select` with selector) |
| Click "Capture page" | `Snapshot` |
| Navigate to a new page | `Goto` (setup) or `Visit` (map) |

The recorder prefers label-based steps over CSS selectors. Labels make scenarios more readable and resilient to markup changes.

## Options

```bash
# Custom filename
flow-map --record my-journey ~/Repos/my-prototype

# Desktop viewport
flow-map --record --desktop ~/Repos/my-prototype

# Custom port
flow-map --record --port 5000 ~/Repos/my-prototype
```

The default filename is `recorded.flow`. If the file already exists, a numeric suffix is added (`recorded-2.flow`, `recorded-3.flow`, etc.).

## Tips

- **Plan your journey first.** Know which pages you want to map before you start recording. You can always edit the `.flow` file afterward.
- **Use Setup for login.** Click through user selection or authentication before hitting "Begin mapping".
- **Use Capture page for dynamic pages.** After clicking through a flow that lands on a page with a dynamic URL (e.g. `/events/abc123/details`), click "Capture page" to record a `Snapshot` step.
- **Close the browser to finish.** If you forget to click "Finish", closing the browser window also saves the recording.
- **Edit afterward.** The generated `.flow` file is plain text — you can reorder steps, add `Wait` steps, remove duplicates, or add `Use` fragments.

## Running recorded scenarios

Once you have a `.flow` file, run it as a scenario:

```bash
flow-map --scenario recorded ~/Repos/my-prototype
```

## Limitations

- No undo — if you make a mistake, finish recording and edit the `.flow` file
- Radio and checkbox clicks are captured by both the click and change handlers — the recorder emits only the click-based step (Choose/Check) and ignores the change event for these input types
- The recorder does not auto-insert `Wait` steps — add them manually if your prototype has timed transitions
- Back button navigations generate a `Visit` to the previous page, which is correct for replay but may not match your intent
