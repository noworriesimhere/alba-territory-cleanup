# Alba Territory Cleanup

Automated cleanup tool for [Alba](https://www.mcmxiv.com/alba/) territory address data.
Deduplication, status management, language filtering, and map pin jitter — all executed
directly against Alba's REST API, preserving address history.

## Project structure

```
src/
  config.js      — Default configuration (status codes, language IDs, jitter params)
  analysis.js    — Pure logic module (zero side effects, fully testable)
test/
  helpers.js     — Test factory for creating fake address objects
  analysis.test.js — 37 unit tests covering all operations
alba-cleanup-v2.js — Browser console script (paste into DevTools while logged into Alba)
```

## Running tests

```bash
npm test            # standard output
npm run test:verbose  # detailed per-test output
```

No dependencies required — uses Node.js built-in test runner (Node 18+).

## How it works

### Analysis pipeline (all pure functions, no side effects)

1. **Language discovery** — Fetches Alba's language list, auto-detects Chinese variants
2. **Deduplication** — Groups by normalized address+suite, picks best keeper (DNC > New > Valid), merges notes/phones
3. **Status cleanup** — Promotes stale Duplicate→New, leaves confirmed losers as Duplicate
4. **Language filter** — Flags empty language fields for assignment to Chinese Mandarin
5. **Jitter** — Spreads overlapping map pins using radar sweep algorithm

### Execution plan

All operations merge into a single `Map<id, planEntry>` so each address gets **at most one PUT request**. No-ops (where the payload matches the original) are automatically removed.

### Safety guarantees (tested)

- **No address is ever deleted** — losers get status changed to Duplicate (5)
- **DNC is sacred** — Do Not Call always wins as keeper, never overwritten
- **Idempotent** — Running twice on clean data produces zero changes
- **No data loss on merge** — Phone numbers and notes from losers are merged into keeper
- **Duplicate notes deduplicated** — Same note from multiple losers only added once

## Usage

1. Log into Alba at `https://www.mcmxiv.com/alba/`
2. Open DevTools (F12) → Console
3. Paste the contents of `alba-cleanup-v2.js`
4. Review the dry-run output
5. When satisfied, change `DRY_RUN = false` and re-run
