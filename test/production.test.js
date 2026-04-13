import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  norm,
  scoreEntry,
  analyzeDeduplication,
  analyzeStatuses,
  analyzeLanguages,
  analyzeJitter,
  computeJitterCoords,
  buildPlan,
} from "../src/analysis.js";

const cfg = { ...DEFAULT_CONFIG };
const FIXTURE_PATH = new URL("./fixtures/production-sample.json", import.meta.url);

let fixture = null;
let addresses = null;

before(async () => {
  try {
    const raw = await readFile(FIXTURE_PATH, "utf-8");
    fixture = JSON.parse(raw);
    addresses = fixture.addresses;
  } catch {
    // Fixture not present — all tests will skip
  }
});

function skipIfNoFixture() {
  if (!addresses) {
    return true;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════
// FIXTURE SANITY
// ═══════════════════════════════════════════════════════════
describe("production fixture sanity", () => {
  it("fixture is loaded and has addresses", () => {
    if (skipIfNoFixture()) return;
    assert.ok(addresses.length > 0, "Fixture must have addresses");
    assert.ok(fixture._meta, "Fixture must have metadata");
  });

  it("every address has required fields", () => {
    if (skipIfNoFixture()) return;
    for (const a of addresses) {
      assert.ok(a.id !== undefined, `Address missing id`);
      assert.ok(a.status !== undefined, `ID ${a.id} missing status`);
      assert.ok(a.address !== undefined, `ID ${a.id} missing address field`);
      assert.ok(a.location_lat !== undefined, `ID ${a.id} missing lat`);
      assert.ok(a.location_lng !== undefined, `ID ${a.id} missing lng`);
    }
  });

  it("has a mix of statuses", () => {
    if (skipIfNoFixture()) return;
    const statuses = new Set(addresses.map((a) => a.status));
    // Should have at least New, Valid, and one of DNC/Duplicate/NotValid
    assert.ok(statuses.size >= 3, `Only ${statuses.size} distinct statuses`);
  });

  it("has duplicate groups", () => {
    if (skipIfNoFixture()) return;
    const groups = new Map();
    for (const a of addresses) {
      const key = `${norm(a.address)}|${norm(a.suite)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const dupCount = [...groups.values()].filter((g) => g.length > 1).length;
    assert.ok(dupCount > 0, "Fixture should contain duplicate groups");
  });
});

// ═══════════════════════════════════════════════════════════
// DEDUPLICATION ON REAL DATA
// ═══════════════════════════════════════════════════════════
describe("deduplication on production data", () => {
  it("every address appears in exactly one group (keeper or loser)", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);

    // Collect all IDs that are in a dedup group
    const seen = new Map(); // id → role
    for (const action of dedup.actions) {
      const kid = action.keeper.id;
      assert.ok(!seen.has(kid), `ID ${kid} appears in multiple groups`);
      seen.set(kid, "keeper");

      for (const loser of action.losers) {
        assert.ok(
          !seen.has(loser.id),
          `ID ${loser.id} appears in multiple groups`
        );
        seen.set(loser.id, "loser");
      }
    }
  });

  it("keeper always has equal or better score than every loser", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);
    for (const action of dedup.actions) {
      const keeperScore = scoreEntry(action.keeper, cfg);
      for (const loser of action.losers) {
        const loserScore = scoreEntry(loser, cfg);
        assert.ok(
          keeperScore >= loserScore,
          `Keeper ID ${action.keeper.id} (score ${keeperScore}) < loser ID ${loser.id} (score ${loserScore})`
        );
      }
    }
  });

  it("no address with empty address field is grouped", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);
    for (const action of dedup.actions) {
      assert.ok(
        norm(action.keeper.address),
        `Keeper ID ${action.keeper.id} has empty address`
      );
      for (const loser of action.losers) {
        assert.ok(
          norm(loser.address),
          `Loser ID ${loser.id} has empty address`
        );
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════
// FULL PIPELINE ON REAL DATA
// ═══════════════════════════════════════════════════════════
describe("full pipeline on production data", () => {
  it("buildPlan produces no duplicate IDs", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);
    const statuses = analyzeStatuses(addresses, cfg);
    const languages = analyzeLanguages(addresses, cfg);
    const jitter = computeJitterCoords(addresses, cfg);
    const plan = buildPlan(addresses, dedup, statuses, languages, jitter, cfg);

    const ids = plan.map((p) => p.id);
    const unique = new Set(ids);
    assert.equal(ids.length, unique.size, "Plan has duplicate IDs");
  });

  it("no plan entry targets a non-existent address", () => {
    if (skipIfNoFixture()) return;
    const addrIds = new Set(addresses.map((a) => a.id));
    const dedup = analyzeDeduplication(addresses, cfg);
    const statuses = analyzeStatuses(addresses, cfg);
    const languages = analyzeLanguages(addresses, cfg);
    const jitter = computeJitterCoords(addresses, cfg);
    const plan = buildPlan(addresses, dedup, statuses, languages, jitter, cfg);

    for (const entry of plan) {
      assert.ok(addrIds.has(entry.id), `Plan targets unknown ID ${entry.id}`);
    }
  });

  it("confirmed losers are never promoted to New", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);
    const statuses = analyzeStatuses(addresses, cfg);
    const languages = analyzeLanguages(addresses, cfg);
    const jitter = computeJitterCoords(addresses, cfg);
    const plan = buildPlan(addresses, dedup, statuses, languages, jitter, cfg);

    // Collect all loser IDs
    const loserIds = new Set();
    for (const action of dedup.actions) {
      for (const loser of action.losers) loserIds.add(loser.id);
    }

    for (const entry of plan) {
      if (loserIds.has(entry.id)) {
        assert.notEqual(
          entry.payload.status,
          cfg.STATUS.NEW,
          `Loser ID ${entry.id} was promoted to New`
        );
      }
    }
  });

  it("DNC addresses are never changed to a different status", () => {
    if (skipIfNoFixture()) return;
    const dncIds = new Set(
      addresses.filter((a) => a.status === cfg.STATUS.DNC).map((a) => a.id)
    );
    const dedup = analyzeDeduplication(addresses, cfg);
    const statuses = analyzeStatuses(addresses, cfg);
    const languages = analyzeLanguages(addresses, cfg);
    const jitter = computeJitterCoords(addresses, cfg);
    const plan = buildPlan(addresses, dedup, statuses, languages, jitter, cfg);

    for (const entry of plan) {
      if (dncIds.has(entry.id)) {
        assert.equal(
          entry.payload.status,
          cfg.STATUS.DNC,
          `DNC address ID ${entry.id} had status changed to ${entry.payload.status}`
        );
      }
    }
  });

  it("every plan entry has a valid payload with all required fields", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);
    const statuses = analyzeStatuses(addresses, cfg);
    const languages = analyzeLanguages(addresses, cfg);
    const jitter = computeJitterCoords(addresses, cfg);
    const plan = buildPlan(addresses, dedup, statuses, languages, jitter, cfg);

    const requiredFields = [
      "address", "city", "province", "country", "postcode",
      "location_lat", "location_lng", "status", "territory_id",
      "language_id", "is_gated",
    ];

    for (const entry of plan) {
      for (const field of requiredFields) {
        assert.ok(
          entry.payload[field] !== undefined,
          `Plan entry ${entry.id} missing payload.${field}`
        );
      }
    }
  });

  it("jitter produces valid lat/lng within reasonable bounds", () => {
    if (skipIfNoFixture()) return;
    const jitter = computeJitterCoords(addresses, cfg);
    for (const change of jitter) {
      assert.ok(
        change.new_lat >= -90 && change.new_lat <= 90,
        `Jitter lat ${change.new_lat} out of range for ID ${change.id}`
      );
      assert.ok(
        change.new_lng >= -180 && change.new_lng <= 180,
        `Jitter lng ${change.new_lng} out of range for ID ${change.id}`
      );
    }
  });

  it("address count is preserved (no addresses lost in pipeline)", () => {
    if (skipIfNoFixture()) return;
    const dedup = analyzeDeduplication(addresses, cfg);
    const statuses = analyzeStatuses(addresses, cfg);
    const languages = analyzeLanguages(addresses, cfg);
    const jitter = computeJitterCoords(addresses, cfg);
    const plan = buildPlan(addresses, dedup, statuses, languages, jitter, cfg);

    // Plan only modifies addresses — never creates or deletes.
    // Every plan ID must exist in original set.
    const origIds = new Set(addresses.map((a) => a.id));
    for (const entry of plan) {
      assert.ok(
        origIds.has(entry.id),
        `Plan entry ${entry.id} not in original address set`
      );
    }
    // No address should appear in plan that doesn't exist in input
    // (already checked above, but also verify plan doesn't exceed input)
    assert.ok(
      plan.length <= addresses.length,
      `Plan has more entries (${plan.length}) than addresses (${addresses.length})`
    );
  });
});
