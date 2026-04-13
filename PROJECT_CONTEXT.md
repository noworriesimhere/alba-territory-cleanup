# Alba Territory Cleanup — Project Context

## What this is

A tool to clean up ~60,000 territory addresses in Alba (https://www.mcmxiv.com/alba/), a territory management web app used by a Mandarin Chinese congregation. The cleanup logic was originally a Google Apps Script (TerritoryCleanUp.js) that operated on exported spreadsheet data. We're replacing that with a script that talks directly to Alba's REST API, so we don't lose address history from export/reimport.

## Alba's API (reverse-engineered via Claude in Chrome)

**Base URL:** `/alba/api` (relative, runs on same domain)  
**Auth:** Session cookie only (HttpOnly). No CSRF, no Bearer tokens, no API keys.  
**Frontend:** SvelteKit (Svelte 5). NOT React, NOT Supabase.  
**Map tiles:** Stadia Maps / OpenStreetMap.

### Endpoints confirmed working:

| Method | Endpoint | Notes |
|--------|----------|-------|
| `GET` | `/alba/api/addresses?limit=N&offset=N&sort=id&order=asc` | Paginated. limit=500 works. Returns `{success, data: {total, addresses: [...]}}` |
| `GET` | `/alba/api/addresses/{id}` | Single address with `created_by_name`, `modified_by_name` |
| `PUT` | `/alba/api/addresses/{id}` | Update address. JSON body. Returns `{success, data: {...}}` |
| `GET` | `/alba/api/languages` | Paginated (default 50). NO `limit` param — use `?offset=N`. Returns `{success, data: {languages: [{id, language}], total}}` |
| `GET` | `/alba/api/territories?limit=N` | Territory list |
| `GET` | `/alba/api/users?limit=N` | User list |

### Address object shape (from API):
```json
{
  "id": 21404180,
  "account_id": 2515,
  "territory_id": 94007,
  "territory_number": "JH-13",
  "created_ts": "2024-02-02T05:37:35.460392+00:00",
  "modified_ts": "2026-04-07T20:44:57.693178+00:00",
  "created_by_id": 150458,
  "modified_by_id": 269757,
  "completed_ts": null,
  "completed_by_id": 0,
  "contacted_ts": null,
  "contacted_by_id": 0,
  "location_lat": 40.753983,
  "location_lng": -73.873259,
  "geocode": 1,
  "user_id": 0,
  "status": 1,
  "interest": 0,
  "language_id": 4,
  "language_name": "Chinese Mandarin",
  "full_name": "Wu, Joseph",
  "suite": "7D",
  "address": "9411 34th Rd",
  "city": "Jackson Heights",
  "province": "NY",
  "country": "US",
  "postcode": "11372",
  "telephone": null,
  "notes": "4/7/26 not in service",
  "notes_private": null,
  "is_gated": false
}
```

### PUT payload shape:
```json
{
  "full_name": "Wu, Joseph",
  "telephone": null,
  "suite": "7D",
  "address": "9411 34th Rd",
  "city": "Jackson Heights",
  "province": "NY",
  "country": "US",
  "postcode": "11372",
  "location_lat": 40.753983,
  "location_lng": -73.873259,
  "status": 1,
  "territory_id": 94007,
  "language_id": 4,
  "contacted_by_id": 0,
  "contacted_ts": null,
  "notes": "4/7/26 not in service",
  "notes_private": null,
  "is_gated": 0
}
```

### Status codes:
| Code | Label |
|------|-------|
| 0 | Unspecified |
| 1 | New |
| 2 | Valid |
| 3 | Do Not Call |
| 4 | Moved |
| 5 | Duplicate |
| 6 | Not Valid |

### Chinese language IDs (auto-discovered from API):
| ID | Language |
|----|----------|
| 83 | Chinese |
| 5 | Chinese Cantonese |
| 188 | Chinese Fukien |
| 258 | Chinese (Fuzhounese) |
| 190 | Chinese Hakka |
| 4 | Chinese Mandarin |
| 189 | Chinese Teochew |
| 73 | Chinese Toisan |
| 259 | Chinese (Wenzhounese) |

## Current production stats (as of April 2026):
- 60,208 total addresses
- 11,370 duplicate groups (19,797 extra copies)
- 9,394 addresses with status=Duplicate
- 11,445 status=Not Valid
- 4,980 status=Moved
- 107 empty language
- 3,877 non-Chinese language
- 10,292 buildings with overlapping map pins (45,747 addresses)

## Operations the script performs:

### 1. Deduplication
- Groups by normalized(address) + normalized(suite)
- Picks best "keeper" per group: DNC (priority 0) > New (1) > Valid (2) > rest (9)
- Tiebreaker: Chinese language bonus (+500), data completeness (phone, name, notes)
- Losers get status changed to Duplicate (5) — never deleted
- Unique phones and notes from losers are merged into keeper's notes field

### 2. Status cleanup
- Addresses currently status=Duplicate that are NOT confirmed dedup losers → change to New
- Addresses with status=Not Valid or Moved → no action (already correctly flagged)
- DNC is SACRED — never changed to any other status

### 3. Language filtering
- Empty language (id=0 or null) → set to Chinese Mandarin (id=4)
- Non-Chinese languages → informational only, no action

### 4. Map pin jitter (radar sweep algorithm)
- Groups by territory, then by building (rounded lat/lng + address)
- For multi-unit buildings: spreads pins along a line using radar sweep
- Starts at 135° (SE), rotates clockwise in 15° steps, 24 attempts
- Spacing: 0.000014° (~1.5m), collision threshold: 0.000014°

## Architecture

```
src/
  config.js      — Default configuration (all magic numbers centralized)
  analysis.js    — Pure logic module. Zero side effects. Every function
                   takes (data, config) and returns results. Fully testable.

test/
  helpers.js     — makeAddr() factory for creating fake address objects
  analysis.test.js    — 37 unit tests (synthetic data)
  production.test.js  — 14 integration tests (against real data fixture)
  fixtures/
    production-sample.json  — PII-sanitized sample of real Alba data
                              (generated by scripts/sample-production-data.js)

scripts/
  sample-production-data.js — Paste into Alba console to generate fixture

alba-cleanup-v2.js  — Browser console script. Self-contained. Paste into
                      DevTools while logged into Alba. Has DRY_RUN toggle.
```

### Key design decisions:
- **Pure functions** — analysis.js has no console.log, no fetch, no DOM. Config is always a parameter.
- **Plan as Map<id, entry>** — each address gets at most one PUT. All operations merge.
- **No-op detection** — plan entries where payload matches original are auto-removed.
- **Tags not reasons** — plan entries have a Set of tags ("set-duplicate", "merge-notes", etc.) for clean aggregation.
- **DRY_RUN toggle** — single boolean at top of browser script.

## What's left to do:

1. **Run the production data sampler** — paste scripts/sample-production-data.js into Alba console, save the fixture to test/fixtures/production-sample.json, commit it
2. **Run production tests with fixture** — `npm test` should now exercise real data patterns
3. **Review dry-run output carefully** — especially the dedup groups with 60+ copies (like 3 Court Sq with 75 copies and 8825 53rd Ave with 67)
4. **Consider running operations in phases** — e.g. dedup first, verify, then status cleanup, then jitter
5. **Build step** — currently alba-cleanup-v2.js duplicates the logic from src/analysis.js. Could add a build script that bundles src/* into a single browser-pasteable file.
6. **Push to GitHub** — repo is initialized locally, needs `gh repo create` or manual push
7. **Consider rate limiting** — 42,000+ PUTs at 350ms = ~4 hours. Could batch by territory or operation type.
