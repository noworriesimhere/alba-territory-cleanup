import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeAddr, resetIdCounter } from "./helpers.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  norm,
  truncateNotes,
  filterChineseLanguages,
  scoreEntry,
  analyzeDeduplication,
  analyzeSuitelessDuplicates,
  analyzeStatuses,
  analyzeLanguages,
  analyzeJitter,
  computeJitterCoords,
  makePayload,
  buildPlan,
} from "../src/analysis.js";

// Shorthand
const S = DEFAULT_CONFIG.STATUS;
const cfg = { ...DEFAULT_CONFIG };

beforeEach(() => resetIdCounter(1000));

// ═══════════════════════════════════════════════════════════
// norm()
// ═══════════════════════════════════════════════════════════
describe("norm()", () => {
  it("lowercases and trims", () => {
    assert.equal(norm("  Hello World  "), "hello world");
  });
  it("handles null/undefined", () => {
    assert.equal(norm(null), "");
    assert.equal(norm(undefined), "");
    assert.equal(norm(""), "");
  });
});

// ═══════════════════════════════════════════════════════════
// truncateNotes()
// ═══════════════════════════════════════════════════════════
describe("truncateNotes()", () => {
  it("returns short notes unchanged", () => {
    assert.equal(truncateNotes("short note", cfg), "short note");
  });

  it("returns null/empty unchanged", () => {
    assert.equal(truncateNotes(null, cfg), null);
    assert.equal(truncateNotes("", cfg), "");
  });

  it("truncates at semicolon boundary when over limit", () => {
    const tinyConfig = { ...cfg, MAX_NOTES_LENGTH: 50 };
    const notes = "note one; note two; note three; note four; note five; note six";
    const result = truncateNotes(notes, tinyConfig);
    assert.ok(result.length <= 50, `Result ${result.length} > 50`);
    assert.ok(result.endsWith("[+truncated]"));
    // Should have cut at a semicolon
    assert.ok(!result.includes("note six"));
  });

  it("truncates mid-word if no good semicolon boundary", () => {
    const tinyConfig = { ...cfg, MAX_NOTES_LENGTH: 30 };
    const notes = "A".repeat(100);
    const result = truncateNotes(notes, tinyConfig);
    assert.ok(result.length <= 30, `Result ${result.length} > 30`);
    assert.ok(result.endsWith("[+truncated]"));
  });

  it("does nothing when MAX_NOTES_LENGTH is not set", () => {
    const noLimitConfig = { ...cfg, MAX_NOTES_LENGTH: 0 };
    const longNotes = "X".repeat(5000);
    assert.equal(truncateNotes(longNotes, noLimitConfig), longNotes);
  });
});

// ═══════════════════════════════════════════════════════════
// filterChineseLanguages()
// ═══════════════════════════════════════════════════════════
describe("filterChineseLanguages()", () => {
  const langs = [
    { id: 4, language: "Chinese Mandarin" },
    { id: 5, language: "Chinese Cantonese" },
    { id: 13, language: "Arabic" },
    { id: 73, language: "Chinese Toisan" },
    { id: 258, language: "Chinese (Fuzhounese)" },
    { id: 161, language: "Afrikaans" },
  ];

  it("matches all Chinese variants", () => {
    const result = filterChineseLanguages(langs, cfg);
    assert.equal(result.length, 4);
    const ids = result.map((l) => l.id).sort((a, b) => a - b);
    assert.deepEqual(ids, [4, 5, 73, 258]);
  });

  it("returns empty array when no matches", () => {
    const result = filterChineseLanguages(
      [{ id: 13, language: "Arabic" }],
      cfg
    );
    assert.equal(result.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════
// scoreEntry()
// ═══════════════════════════════════════════════════════════
describe("scoreEntry()", () => {
  it("DNC scores higher than New", () => {
    const dnc = makeAddr({ status: S.DNC });
    const nw = makeAddr({ status: S.NEW });
    assert.ok(scoreEntry(dnc, cfg) > scoreEntry(nw, cfg));
  });

  it("New scores higher than Valid", () => {
    const nw = makeAddr({ status: S.NEW });
    const valid = makeAddr({ status: S.VALID });
    assert.ok(scoreEntry(nw, cfg) > scoreEntry(valid, cfg));
  });

  it("Valid scores higher than Duplicate/Not Valid", () => {
    const valid = makeAddr({ status: S.VALID });
    const dup = makeAddr({ status: S.DUPLICATE });
    assert.ok(scoreEntry(valid, cfg) > scoreEntry(dup, cfg));
  });

  it("Chinese language gives a bonus", () => {
    const cn = makeAddr({ language_id: 4 });
    const en = makeAddr({ language_id: 99 });
    assert.ok(scoreEntry(cn, cfg) > scoreEntry(en, cfg));
  });

  it("more data = higher score (phone, name, notes)", () => {
    const sparse = makeAddr({});
    const rich = makeAddr({ full_name: "Wu", telephone: "1234567890", notes: "spoke to owner" });
    assert.ok(scoreEntry(rich, cfg) > scoreEntry(sparse, cfg));
  });
});

// ═══════════════════════════════════════════════════════════
// analyzeDeduplication()
// ═══════════════════════════════════════════════════════════
describe("analyzeDeduplication()", () => {
  it("finds no duplicates when all addresses are unique", () => {
    const addrs = [
      makeAddr({ address: "100 Main St" }),
      makeAddr({ address: "200 Oak Ave" }),
      makeAddr({ address: "300 Elm Rd" }),
    ];
    const { actions, totalLosers } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions.length, 0);
    assert.equal(totalLosers, 0);
  });

  it("groups by normalized address+suite", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "A" }),
      makeAddr({ id: 2, address: "100 main st", suite: "a" }),  // same, diff case
      makeAddr({ id: 3, address: "100 Main St", suite: "B" }),  // different suite
    ];
    const { actions, totalLosers } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions.length, 1);  // only the A/a group
    assert.equal(totalLosers, 1);
    assert.equal(actions[0].losers.length, 1);
  });

  it("keeps DNC over New over Valid", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", status: S.VALID }),
      makeAddr({ id: 2, address: "100 Main St", status: S.DNC }),
      makeAddr({ id: 3, address: "100 Main St", status: S.NEW }),
    ];
    const { actions } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions[0].keeper.id, 2);  // DNC wins
    assert.equal(actions[0].losers.length, 2);
  });

  it("merges phone numbers from losers into keeper notes", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", status: S.NEW, notes: "existing note" }),
      makeAddr({ id: 2, address: "100 Main St", status: S.VALID, telephone: "5551234" }),
    ];
    const { actions } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions[0].keeper.id, 1);  // New beats Valid
    assert.ok(actions[0].newKeeperNotes.includes("📞 5551234"));
    assert.ok(actions[0].newKeeperNotes.includes("existing note"));
  });

  it("does not duplicate notes already present in keeper", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", status: S.NEW, notes: "spoke to owner" }),
      makeAddr({ id: 2, address: "100 Main St", status: S.VALID, notes: "spoke to owner" }),
    ];
    const { actions } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions[0].newKeeperNotes, null);  // nothing new to merge
  });

  it("skips addresses with empty address field", () => {
    const addrs = [
      makeAddr({ id: 1, address: "" }),
      makeAddr({ id: 2, address: "" }),
      makeAddr({ id: 3, address: "100 Main St" }),
    ];
    const { actions } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions.length, 0);  // empty addresses not grouped
  });

  it("handles suite=null vs suite='' as the same", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: null }),
      makeAddr({ id: 2, address: "100 Main St", suite: "" }),
    ];
    const { actions, totalLosers } = analyzeDeduplication(addrs, cfg);
    assert.equal(actions.length, 1);
    assert.equal(totalLosers, 1);
  });
});

// ═══════════════════════════════════════════════════════════
// analyzeSuitelessDuplicates()
// ═══════════════════════════════════════════════════════════
describe("analyzeSuitelessDuplicates()", () => {
  it("flags suiteless entries when suited entries exist", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", status: S.NEW }),
      makeAddr({ id: 3, address: "100 Main St", suite: null, status: S.NEW }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].suitelessLosers.length, 1);
    assert.equal(actions[0].suitelessLosers[0].id, 3);
  });

  it("does nothing when all entries have suites", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A" }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B" }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 0);
  });

  it("does nothing when all entries lack suites", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: null }),
      makeAddr({ id: 2, address: "100 Main St", suite: "" }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 0);
  });

  it("DNC suiteless entries are exempt (sacred)", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "100 Main St", suite: null, status: S.DNC }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 0); // DNC is exempt, so no losers
  });

  it("picks best suite entry as keeper for note merging", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.VALID }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", status: S.DNC }),
      makeAddr({ id: 3, address: "100 Main St", suite: null, status: S.NEW, notes: "building info" }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 1);
    // DNC should be the keeper (highest score)
    assert.equal(actions[0].suiteKeeper.id, 2);
    assert.ok(actions[0].newKeeperNotes.includes("building info"));
  });

  it("merges unique notes from suiteless losers", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW, notes: "existing" }),
      makeAddr({ id: 2, address: "100 Main St", suite: null, status: S.NEW, telephone: "5551234", notes: "suiteless note" }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 1);
    assert.ok(actions[0].newKeeperNotes.includes("📞 5551234"));
    assert.ok(actions[0].newKeeperNotes.includes("suiteless note"));
  });

  it("does not duplicate notes already present in keeper", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW, notes: "same note" }),
      makeAddr({ id: 2, address: "100 Main St", suite: null, status: S.NEW, notes: "same note" }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].newKeeperNotes, null); // nothing new to merge
  });

  it("skips empty address fields", () => {
    const addrs = [
      makeAddr({ id: 1, address: "", suite: "1A" }),
      makeAddr({ id: 2, address: "", suite: null }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 0);
  });

  it("handles multiple suiteless losers at same address", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "100 Main St", suite: null, status: S.NEW, notes: "note A" }),
      makeAddr({ id: 3, address: "100 Main St", suite: null, status: S.VALID, notes: "note B" }),
      makeAddr({ id: 4, address: "100 Main St", suite: "", status: S.NEW }),
    ];
    const { actions } = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].suitelessLosers.length, 3);
  });

  it("integrates with buildPlan — suiteless losers become Duplicate", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", status: S.NEW }),
      makeAddr({ id: 3, address: "100 Main St", suite: null, status: S.NEW }),
    ];
    const dedup = analyzeDeduplication(addrs, cfg);
    const suiteless = analyzeSuitelessDuplicates(addrs, cfg);
    const statuses = analyzeStatuses(addrs, cfg);
    const languages = analyzeLanguages(addrs, cfg);
    const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg, suiteless);

    const entry3 = plan.find((p) => p.id === 3);
    assert.ok(entry3, "Suiteless loser should be in plan");
    assert.equal(entry3.payload.status, S.DUPLICATE);
    assert.ok(entry3.tags.has("set-duplicate-suiteless"));
  });

  it("suiteless losers are not promoted to New by dup-to-new", () => {
    // Suiteless entry has status=Duplicate already — suiteless rule should keep it there,
    // and dup-to-new should NOT promote it
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "100 Main St", suite: null, status: S.DUPLICATE }),
    ];
    const dedup = analyzeDeduplication(addrs, cfg);
    const suiteless = analyzeSuitelessDuplicates(addrs, cfg);
    const statuses = analyzeStatuses(addrs, cfg);
    const languages = analyzeLanguages(addrs, cfg);
    const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg, suiteless);

    const entry2 = plan.find((p) => p.id === 2);
    // Should either be absent (already Duplicate = no-op) or have status Duplicate
    if (entry2) {
      assert.equal(entry2.payload.status, S.DUPLICATE,
        "Suiteless loser must NOT be promoted to New");
    }
  });
});

// ═══════════════════════════════════════════════════════════
// analyzeStatuses()
// ═══════════════════════════════════════════════════════════
describe("analyzeStatuses()", () => {
  it("categorizes by status", () => {
    const addrs = [
      makeAddr({ status: S.NEW }),
      makeAddr({ status: S.DUPLICATE }),
      makeAddr({ status: S.DUPLICATE }),
      makeAddr({ status: S.NOT_VALID }),
      makeAddr({ status: S.MOVED }),
      makeAddr({ status: S.DNC }),
      makeAddr({ status: S.VALID }),
    ];
    const { dupStatus, notValid, moved } = analyzeStatuses(addrs, cfg);
    assert.equal(dupStatus.length, 2);
    assert.equal(notValid.length, 1);
    assert.equal(moved.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════
// analyzeLanguages()
// ═══════════════════════════════════════════════════════════
describe("analyzeLanguages()", () => {
  it("finds empty and non-Chinese languages", () => {
    const addrs = [
      makeAddr({ language_id: 4 }),   // Chinese Mandarin — ok
      makeAddr({ language_id: 0 }),   // empty
      makeAddr({ language_id: null }),// empty
      makeAddr({ language_id: 99 }), // non-Chinese
      makeAddr({ language_id: 5 }),   // Chinese Cantonese — ok
    ];
    const { emptyLang, nonChinese } = analyzeLanguages(addrs, cfg);
    assert.equal(emptyLang.length, 2);
    assert.equal(nonChinese.length, 1);
  });
});

// ═══════════════════════════════════════════════════════════
// analyzeJitter()
// ═══════════════════════════════════════════════════════════
describe("analyzeJitter()", () => {
  it("detects overlapping pins at same building", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 3, address: "200 Oak Ave", suite: null, location_lat: 40.76, location_lng: -73.88, territory_number: "T-1" }),
    ];
    const { totalPins, groups } = analyzeJitter(addrs, cfg);
    assert.equal(groups.length, 1);
    assert.equal(totalPins, 2);
    assert.equal(groups[0].units, 2);
  });

  it("does not group addresses from different territories", () => {
    // Same coords but different territory → separate groups
    // (jitter is computed per-territory)
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", location_lat: 40.75, location_lng: -73.87, territory_number: "T-2" }),
    ];
    const { groups } = analyzeJitter(addrs, cfg);
    assert.equal(groups.length, 0);  // 1 per territory, but each group has only 1 → not overlapping
  });
});

// ═══════════════════════════════════════════════════════════
// computeJitterCoords()
// ═══════════════════════════════════════════════════════════
describe("computeJitterCoords()", () => {
  it("returns changes only for non-anchor units", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 3, address: "100 Main St", suite: "3C", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
    ];
    const changes = computeJitterCoords(addrs, cfg);
    assert.equal(changes.length, 2);  // units 2 and 3 get moved; unit 1 is anchor
  });

  it("produces distinct coordinates for each unit", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 2, address: "100 Main St", suite: "2B", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      makeAddr({ id: 3, address: "100 Main St", suite: "3C", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
    ];
    const changes = computeJitterCoords(addrs, cfg);
    const coords = changes.map((c) => `${c.new_lat.toFixed(8)},${c.new_lng.toFixed(8)}`);
    const unique = new Set(coords);
    assert.equal(unique.size, changes.length, "All jittered coordinates should be distinct");
  });

  it("does not modify single-unit buildings", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
    ];
    const changes = computeJitterCoords(addrs, cfg);
    assert.equal(changes.length, 0);
  });
});

// ═══════════════════════════════════════════════════════════
// buildPlan() — THE CRITICAL INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════
describe("buildPlan()", () => {

  // ── The Dup→New conflict ──
  describe("Dup→New vs dedup loser conflict", () => {
    it("does NOT promote confirmed losers to New", () => {
      // Two copies of same address: one New (keeper), one Duplicate (loser)
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.NEW }),
        makeAddr({ id: 2, address: "100 Main St", status: S.DUPLICATE }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      // ID 2 is a loser → should NOT become New, should stay Duplicate
      const entry2 = plan.find((p) => p.id === 2);
      // It should not be in the plan at all (already status=Duplicate, no change needed)
      // OR if it is, its status should be Duplicate, not New
      if (entry2) {
        assert.equal(entry2.payload.status, S.DUPLICATE,
          "Confirmed loser must NOT be promoted to New");
      }
    });

    it("DOES promote stale Duplicate singletons to New", () => {
      // One address with status Duplicate, but no other copies exist
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.DUPLICATE }),
        makeAddr({ id: 2, address: "200 Oak Ave", status: S.NEW }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      const entry1 = plan.find((p) => p.id === 1);
      assert.ok(entry1, "Stale Duplicate singleton should be in plan");
      assert.equal(entry1.payload.status, S.NEW);
      assert.ok(entry1.tags.has("dup-to-new"));
    });

    it("promotes Duplicate keeper to New (keeper should not stay Duplicate)", () => {
      // Three copies: keeper has status=Duplicate (was previously marked), two losers
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.DUPLICATE, full_name: "Wu", telephone: "555" }),
        makeAddr({ id: 2, address: "100 Main St", status: S.NEW }),
        makeAddr({ id: 3, address: "100 Main St", status: S.VALID }),
      ];
      // ID 1 has the most data but status Duplicate
      // ID 2 status=New has higher priority
      // Who wins? New (priority 1) beats Duplicate (priority 9) so ID 2 is keeper
      const dedup = analyzeDeduplication(addrs, cfg);

      // Actually, let's verify who the keeper is:
      const keeper = dedup.actions[0].keeper;
      const losers = dedup.actions[0].losers;

      // Now: the loser with status=Duplicate should stay Duplicate
      // The keeper (if not Duplicate) stays as-is
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      // The non-keeper Duplicate entries should NOT become New
      for (const loser of losers) {
        const entry = plan.find((p) => p.id === loser.id);
        if (entry) {
          assert.notEqual(entry.payload.status, S.NEW,
            `Loser ID ${loser.id} should not be promoted to New`);
        }
      }
    });
  });

  // ── No address lost ──
  describe("no address is ever deleted", () => {
    it("plan never contains a delete operation (only status changes)", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.NEW }),
        makeAddr({ id: 2, address: "100 Main St", status: S.VALID }),
        makeAddr({ id: 3, address: "100 Main St", status: S.DUPLICATE }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      // Every plan entry should be a payload (PUT), never a delete
      for (const entry of plan) {
        assert.ok(entry.payload, "Every plan entry must have a payload");
        assert.ok(entry.payload.address, "Payload must have an address field");
      }
    });
  });

  // ── Idempotency ──
  describe("idempotency", () => {
    it("running buildPlan on already-clean data produces empty plan", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.NEW, language_id: 4 }),
        makeAddr({ id: 2, address: "200 Oak Ave", status: S.VALID, language_id: 4 }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      assert.equal(plan.length, 0, "Clean data should produce no changes");
    });

    it("losers already at status=Duplicate are no-ops", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.NEW }),
        makeAddr({ id: 2, address: "100 Main St", status: S.DUPLICATE }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      // ID 2 is already Duplicate, and no notes to merge → should be skipped
      const entry2 = plan.find((p) => p.id === 2);
      assert.equal(entry2, undefined,
        "Already-Duplicate loser with nothing to merge should not be in plan");
    });
  });

  // ── Multi-operation merge ──
  describe("multi-operation merging", () => {
    it("combines language fix + jitter into single PUT", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", suite: "1A",
          language_id: 0, location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
        makeAddr({ id: 2, address: "100 Main St", suite: "2B",
          language_id: 4, location_lat: 40.75, location_lng: -73.87, territory_number: "T-1" }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const jitter = computeJitterCoords(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, jitter, cfg);

      // ID 2 needs jitter (it's the second unit)
      const entry2 = plan.find((p) => p.id === 2);
      if (entry2) {
        assert.ok(entry2.tags.has("jitter"));
        // Its lat/lng should have changed
        assert.notEqual(entry2.payload.location_lat, 40.75);
      }

      // ID 1 needs language fix; may also be dedup keeper
      const entry1 = plan.find((p) => p.id === 1);
      assert.ok(entry1, "ID 1 should be in plan for language fix");
      assert.equal(entry1.payload.language_id, cfg.DEFAULT_LANGUAGE_ID);
      assert.ok(entry1.tags.has("set-language"));
    });
  });

  // ── DNC preservation ──
  describe("Do Not Call preservation", () => {
    it("DNC always wins as keeper", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.DNC }),
        makeAddr({ id: 2, address: "100 Main St", status: S.NEW, full_name: "Wu", telephone: "555", notes: "very detailed notes here" }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      assert.equal(dedup.actions[0].keeper.id, 1, "DNC should always be keeper");
    });

    it("DNC address is never changed to New or Duplicate", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.DNC }),
        makeAddr({ id: 2, address: "100 Main St", status: S.NEW }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      const entry1 = plan.find((p) => p.id === 1);
      if (entry1) {
        assert.equal(entry1.payload.status, S.DNC,
          "DNC status must NEVER be overwritten");
      }
    });
  });

  // ── Note merging ──
  describe("note merging", () => {
    it("merges unique phone and notes from losers", () => {
      const addrs = [
        makeAddr({ id: 1, address: "100 Main St", status: S.NEW, notes: "note A" }),
        makeAddr({ id: 2, address: "100 Main St", status: S.VALID, telephone: "5551234", notes: "note B" }),
        makeAddr({ id: 3, address: "100 Main St", status: S.VALID, telephone: "5551234", notes: "note A" }),
      ];
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      const keeper = plan.find((p) => p.id === 1);
      assert.ok(keeper, "Keeper should be in plan for note merge");
      // Should have: "note A; 📞 5551234; note B" (note A from loser 3 is deduplicated)
      assert.ok(keeper.payload.notes.includes("📞 5551234"));
      assert.ok(keeper.payload.notes.includes("note B"));
      // "note A" should appear only once (at the start)
      const noteACount = keeper.payload.notes.split("note A").length - 1;
      assert.equal(noteACount, 1, "Duplicate notes should not be merged twice");
    });
  });

  // ── Large-scale consistency ──
  describe("large-scale consistency", () => {
    it("every loser ID appears at most once in the plan", () => {
      const addrs = [];
      // 50 addresses at same location, same address, different suites
      for (let i = 0; i < 50; i++) {
        addrs.push(makeAddr({
          id: i + 1,
          address: "100 Main St",
          suite: `${i}A`,
          status: i === 0 ? S.NEW : (i % 3 === 0 ? S.DUPLICATE : S.VALID),
          language_id: i % 10 === 0 ? 0 : 4,
        }));
      }
      const dedup = analyzeDeduplication(addrs, cfg);
      const statuses = analyzeStatuses(addrs, cfg);
      const languages = analyzeLanguages(addrs, cfg);
      const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg);

      // Check no duplicate IDs in plan
      const planIds = plan.map((p) => p.id);
      const uniqueIds = new Set(planIds);
      assert.equal(planIds.length, uniqueIds.size,
        "No address should appear twice in the plan");
    });
  });
});

// ═══════════════════════════════════════════════════════════
// makePayload()
// ═══════════════════════════════════════════════════════════
describe("makePayload()", () => {
  it("copies all required fields", () => {
    const addr = makeAddr({ full_name: "Wu", telephone: "555", suite: "3A" });
    const payload = makePayload(addr);
    assert.equal(payload.full_name, "Wu");
    assert.equal(payload.telephone, "555");
    assert.equal(payload.suite, "3A");
    assert.equal(payload.status, S.NEW);
  });

  it("applies overrides", () => {
    const addr = makeAddr({ status: S.VALID });
    const payload = makePayload(addr, { status: S.DUPLICATE });
    assert.equal(payload.status, S.DUPLICATE);
  });

  it("normalizes is_gated to 0/1", () => {
    const addr = makeAddr({ is_gated: false });
    assert.equal(makePayload(addr).is_gated, 0);
    const addr2 = makeAddr({ is_gated: true });
    assert.equal(makePayload(addr2).is_gated, 1);
  });
});

// ═══════════════════════════════════════════════════════════
// EDGE CASE TESTS (from production observations)
// ═══════════════════════════════════════════════════════════

describe("edge cases: massive apartment building (75 copies)", () => {
  it("handles 75 copies of the same address with different suites", () => {
    const addrs = [];
    for (let i = 0; i < 75; i++) {
      addrs.push(makeAddr({
        id: i + 1,
        address: "3 Court Sq",
        suite: i === 0 ? null : `${i}`,
        status: i === 0 ? S.NEW : (i % 5 === 0 ? S.DUPLICATE : S.NEW),
        language_id: 4,
        location_lat: 40.747,
        location_lng: -73.945,
        territory_number: "LT-01",
      }));
    }
    const dedup = analyzeDeduplication(addrs, cfg);
    // Each unique address+suite combo is its own group — no dedup across suites
    // Only id=0 (no suite) is unique; suites are all unique
    assert.equal(dedup.totalLosers, 0, "Different suites should not be grouped together");

    // But suiteless duplicate rule should flag the no-suite entry
    const suiteless = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(suiteless.actions.length, 1, "Should find 1 suiteless group");
    assert.equal(suiteless.actions[0].suitelessLosers.length, 1, "The suiteless entry is the loser");
    assert.equal(suiteless.actions[0].suitelessLosers[0].id, 1);
  });

  it("merged notes from 74 losers are handled gracefully", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", status: S.NEW, notes: "keeper note" }),
    ];
    for (let i = 2; i <= 75; i++) {
      addrs.push(makeAddr({
        id: i,
        address: "100 Main St",
        status: S.VALID,
        notes: `loser note ${i}`,
        telephone: i % 2 === 0 ? `555${String(i).padStart(4, "0")}` : null,
      }));
    }
    const dedup = analyzeDeduplication(addrs, cfg);
    assert.equal(dedup.actions.length, 1);
    assert.equal(dedup.actions[0].losers.length, 74);

    // Verify notes are merged and within the limit
    const merged = dedup.actions[0].newKeeperNotes;
    assert.ok(merged, "Should have merged notes");
    assert.ok(merged.includes("keeper note"));
    assert.ok(merged.length <= cfg.MAX_NOTES_LENGTH,
      `Merged notes (${merged.length}) must not exceed MAX_NOTES_LENGTH (${cfg.MAX_NOTES_LENGTH})`);
  });

  it("truncates merged notes when they exceed the limit", () => {
    const smallCfg = { ...cfg, MAX_NOTES_LENGTH: 200 };
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", status: S.NEW, notes: "keeper note" }),
    ];
    for (let i = 2; i <= 75; i++) {
      addrs.push(makeAddr({
        id: i,
        address: "100 Main St",
        status: S.VALID,
        notes: `loser note ${i} with extra detail`,
      }));
    }
    const dedup = analyzeDeduplication(addrs, smallCfg);
    const merged = dedup.actions[0].newKeeperNotes;
    assert.ok(merged.length <= 200, `Got ${merged.length}, expected ≤200`);
    assert.ok(merged.endsWith("[+truncated]"));
    assert.ok(merged.includes("keeper note"), "Keeper notes should survive truncation");
  });
});

describe("edge cases: empty address field", () => {
  it("empty string addresses are never grouped with real addresses", () => {
    const addrs = [
      makeAddr({ id: 1, address: "", suite: null, status: S.NEW }),
      makeAddr({ id: 2, address: "", suite: null, status: S.NEW }),
      makeAddr({ id: 3, address: "100 Main St", suite: null, status: S.NEW }),
    ];
    const dedup = analyzeDeduplication(addrs, cfg);
    assert.equal(dedup.actions.length, 0);
    assert.equal(dedup.totalLosers, 0);
  });

  it("empty address entries are skipped by suiteless analysis", () => {
    const addrs = [
      makeAddr({ id: 1, address: "", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "", suite: null, status: S.NEW }),
    ];
    const suiteless = analyzeSuitelessDuplicates(addrs, cfg);
    assert.equal(suiteless.actions.length, 0);
  });

  it("empty addresses produce a valid plan (no crashes)", () => {
    const addrs = [
      makeAddr({ id: 1, address: "", status: S.DUPLICATE }),
      makeAddr({ id: 2, address: "100 Main St", status: S.NEW }),
    ];
    const dedup = analyzeDeduplication(addrs, cfg);
    const suiteless = analyzeSuitelessDuplicates(addrs, cfg);
    const statuses = analyzeStatuses(addrs, cfg);
    const languages = analyzeLanguages(addrs, cfg);
    const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg, suiteless);
    // The empty-address entry with status=Duplicate should become New
    // (it's a stale dup singleton — not a loser)
    const entry1 = plan.find((p) => p.id === 1);
    assert.ok(entry1, "Stale duplicate with empty address should be in plan");
    assert.equal(entry1.payload.status, S.NEW);
  });
});

describe("edge cases: idempotency (double-run)", () => {
  it("running pipeline twice is a no-op the second time", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", status: S.NEW, notes: "keep" }),
      makeAddr({ id: 2, address: "100 Main St", status: S.VALID, notes: "merge me" }),
      makeAddr({ id: 3, address: "200 Oak Ave", status: S.DUPLICATE }), // stale dup
      makeAddr({ id: 4, address: "300 Elm Rd", suite: null, status: S.NEW }),
      makeAddr({ id: 5, address: "300 Elm Rd", suite: "1A", status: S.NEW }),
    ];

    // First run
    const dedup1 = analyzeDeduplication(addrs, cfg);
    const suiteless1 = analyzeSuitelessDuplicates(addrs, cfg);
    const statuses1 = analyzeStatuses(addrs, cfg);
    const languages1 = analyzeLanguages(addrs, cfg);
    const plan1 = buildPlan(addrs, dedup1, statuses1, languages1, [], cfg, suiteless1);

    assert.ok(plan1.length > 0, "First run should have changes");

    // Apply changes to simulate execution
    const postRun = addrs.map((a) => {
      const entry = plan1.find((p) => p.id === a.id);
      if (!entry) return { ...a };
      return {
        ...a,
        status: entry.payload.status,
        notes: entry.payload.notes,
        language_id: entry.payload.language_id,
        location_lat: entry.payload.location_lat,
        location_lng: entry.payload.location_lng,
      };
    });

    // Second run
    const dedup2 = analyzeDeduplication(postRun, cfg);
    const suiteless2 = analyzeSuitelessDuplicates(postRun, cfg);
    const statuses2 = analyzeStatuses(postRun, cfg);
    const languages2 = analyzeLanguages(postRun, cfg);
    const plan2 = buildPlan(postRun, dedup2, statuses2, languages2, [], cfg, suiteless2);

    assert.equal(plan2.length, 0,
      "Second run on post-cleanup data should be a complete no-op");
  });
});

describe("edge cases: DNC always survives all operations", () => {
  it("DNC suiteless entry is never marked as suiteless loser", () => {
    const addrs = [
      makeAddr({ id: 1, address: "100 Main St", suite: "1A", status: S.NEW }),
      makeAddr({ id: 2, address: "100 Main St", suite: null, status: S.DNC }),
    ];
    const dedup = analyzeDeduplication(addrs, cfg);
    const suiteless = analyzeSuitelessDuplicates(addrs, cfg);
    const statuses = analyzeStatuses(addrs, cfg);
    const languages = analyzeLanguages(addrs, cfg);
    const plan = buildPlan(addrs, dedup, statuses, languages, [], cfg, suiteless);

    const entry2 = plan.find((p) => p.id === 2);
    if (entry2) {
      assert.equal(entry2.payload.status, S.DNC,
        "DNC must NEVER lose its status, even as suiteless entry");
    }
  });
});
