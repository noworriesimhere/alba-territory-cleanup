// ╔══════════════════════════════════════════════════════════════════╗
// ║  ALBA DATA SAMPLER — Console Script                            ║
// ║  Paste into DevTools while logged into Alba                    ║
// ║                                                                ║
// ║  Scrapes a representative sample of addresses and sanitizes    ║
// ║  PII so it can be committed to a test repo.                    ║
// ╚══════════════════════════════════════════════════════════════════╝

// ── CONFIG ──
const SAMPLE = {
  // How many addresses per category to sample
  PER_STATUS: 30,      // 30 per status = ~210 addresses across 7 statuses
  DUPLICATES: 100,     // 100 addresses that have duplicates (will pull full groups)
  EMPTY_LANG: 20,      // addresses with empty language
  NON_CHINESE: 30,     // non-Chinese language addresses
  OVERLAP_BUILDINGS: 15,// buildings with overlapping pins (pull all units)

  API: "/alba/api",
  PAGE_SIZE: 500,
  DELAY_MS: 200,
};

// ── PII SANITIZATION ──
// Replaces real names/phones/notes with realistic fakes,
// but preserves structure (length, presence/absence, separators).
const SURNAMES = [
  "Chen", "Wang", "Li", "Zhang", "Liu", "Yang", "Huang", "Wu",
  "Zhou", "Xu", "Lin", "Zhao", "He", "Ma", "Gao", "Sun",
];
const FIRST_NAMES = [
  "Wei", "Ming", "Jun", "Fang", "Hua", "Lei", "Jing", "Yong",
  "Xin", "Ping", "Bo", "Lan", "Qiang", "Mei", "Tao", "Hong",
];
const NOTE_TEMPLATES = [
  "not home 3x",
  "spoke to resident, not interested",
  "buzzer broken, try side door",
  "called, no answer",
  "left voicemail",
  "moved out per neighbor",
  "language barrier",
  "very friendly, callback",
  "do not visit before 10am",
  "gate code needed",
  "elderly resident",
  "apartment converted to office",
  "building under renovation",
  "dog in yard, be careful",
  "ring bell twice",
];

let _nameCounter = 0;
let _phoneCounter = 5550100;

function fakeName() {
  const s = SURNAMES[_nameCounter % SURNAMES.length];
  const f = FIRST_NAMES[Math.floor(_nameCounter / SURNAMES.length) % FIRST_NAMES.length];
  _nameCounter++;
  return `${s}, ${f}`;
}

function fakePhone() {
  _phoneCounter++;
  return `${_phoneCounter}`;
}

function fakeNotes(original) {
  if (!original) return null;
  // Preserve semicolons (merged notes structure) but replace content
  const parts = original.split(";").map((_, i) =>
    NOTE_TEMPLATES[(i * 7 + _nameCounter) % NOTE_TEMPLATES.length]
  );
  return parts.join("; ");
}

function sanitizeAddress(a) {
  return {
    // Preserve these exactly (needed for dedup/jitter/status logic)
    id: a.id,
    account_id: a.account_id,
    territory_id: a.territory_id,
    territory_number: a.territory_number,
    status: a.status,
    language_id: a.language_id,
    language_name: a.language_name,
    location_lat: a.location_lat,
    location_lng: a.location_lng,
    suite: a.suite,
    address: a.address,
    city: a.city,
    province: a.province,
    country: a.country,
    postcode: a.postcode,
    is_gated: a.is_gated,
    created_ts: a.created_ts,
    modified_ts: a.modified_ts,
    contacted_ts: a.contacted_ts,
    contacted_by_id: a.contacted_by_id,

    // Sanitize PII
    full_name: a.full_name ? fakeName() : null,
    telephone: a.telephone ? fakePhone() : null,
    notes: fakeNotes(a.notes),
    notes_private: a.notes_private ? "admin note" : null,
  };
}

// ── API HELPERS ──
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => (s || "").toLowerCase().trim();

async function apiFetch(path) {
  const resp = await fetch(`${SAMPLE.API}${path}`, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${path}`);
  const json = await resp.json();
  if (!json.success) throw new Error(`API error on ${path}`);
  return json.data;
}

async function fetchAll() {
  let all = [];
  let offset = 0;
  while (true) {
    const data = await apiFetch(
      `/addresses?limit=${SAMPLE.PAGE_SIZE}&offset=${offset}&sort=id&order=asc`
    );
    if (!data.addresses || data.addresses.length === 0) break;
    all = all.concat(data.addresses);
    offset += data.addresses.length;
    if (all.length % 5000 < SAMPLE.PAGE_SIZE)
      console.log(`  fetched ${all.length.toLocaleString()} / ${data.total.toLocaleString()}...`);
    if (all.length >= data.total) break;
    await sleep(SAMPLE.DELAY_MS);
  }
  return all;
}

// ── MAIN ──
(async function main() {
  console.clear();
  console.log("%c📊 ALBA DATA SAMPLER", "font-size:16px; font-weight:bold; color:#60a5fa;");
  console.log("Fetching all addresses to build a representative sample...\n");

  try {
    const all = await fetchAll();
    console.log(`\n✅ Fetched ${all.length.toLocaleString()} total addresses\n`);

    const sampled = new Map(); // id → address (deduped)
    const add = (a) => { if (a && !sampled.has(a.id)) sampled.set(a.id, a); };
    const addAll = (arr) => arr.forEach(add);

    // ── 1. Sample per status ──
    console.log("Sampling by status...");
    for (let status = 0; status <= 6; status++) {
      const matching = all.filter(a => a.status === status);
      const shuffled = matching.sort(() => Math.random() - 0.5);
      addAll(shuffled.slice(0, SAMPLE.PER_STATUS));
      console.log(`  status=${status}: ${Math.min(matching.length, SAMPLE.PER_STATUS)} sampled (of ${matching.length})`);
    }

    // ── 2. Sample duplicate groups ──
    console.log("\nSampling duplicate groups...");
    const groups = new Map();
    for (const a of all) {
      const addr = norm(a.address);
      if (!addr) continue;
      const key = `${addr}|${norm(a.suite)}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    const dupGroups = [...groups.values()]
      .filter(g => g.length > 1)
      .sort((a, b) => b.length - a.length);

    let dupSampled = 0;
    for (const group of dupGroups) {
      if (dupSampled >= SAMPLE.DUPLICATES) break;
      addAll(group);
      dupSampled += group.length;
    }
    console.log(`  ${dupSampled} addresses from ${Math.min(dupGroups.length, SAMPLE.DUPLICATES)} duplicate groups`);

    // ── 3. Empty language ──
    console.log("\nSampling empty language...");
    const emptyLang = all.filter(a => !a.language_id || a.language_id === 0);
    addAll(emptyLang.sort(() => Math.random() - 0.5).slice(0, SAMPLE.EMPTY_LANG));
    console.log(`  ${Math.min(emptyLang.length, SAMPLE.EMPTY_LANG)} sampled (of ${emptyLang.length})`);

    // ── 4. Non-Chinese language ──
    console.log("\nSampling non-Chinese language...");
    const chineseIds = new Set([83, 5, 188, 258, 190, 4, 189, 73, 259]);
    const nonChinese = all.filter(a => a.language_id && a.language_id !== 0 && !chineseIds.has(a.language_id));
    addAll(nonChinese.sort(() => Math.random() - 0.5).slice(0, SAMPLE.NON_CHINESE));
    console.log(`  ${Math.min(nonChinese.length, SAMPLE.NON_CHINESE)} sampled (of ${nonChinese.length})`);

    // ── 5. Overlapping pin buildings ──
    console.log("\nSampling overlapping pin buildings...");
    const precision = 4;
    const buildingMap = new Map();
    for (const a of all) {
      const lat = parseFloat(a.location_lat);
      const lng = parseFloat(a.location_lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      const key = `${a.territory_number}|${a.address}_${lat.toFixed(precision)}_${lng.toFixed(precision)}`;
      if (!buildingMap.has(key)) buildingMap.set(key, []);
      buildingMap.get(key).push(a);
    }
    const overlapBuildings = [...buildingMap.values()]
      .filter(g => g.length > 1)
      .sort((a, b) => b.length - a.length);

    let overlapSampled = 0;
    for (const group of overlapBuildings) {
      if (overlapSampled >= SAMPLE.OVERLAP_BUILDINGS) break;
      addAll(group);
      overlapSampled++;
    }
    console.log(`  ${overlapSampled} buildings sampled`);

    // ── Sanitize ──
    console.log("\nSanitizing PII...");
    const sanitized = [...sampled.values()].map(sanitizeAddress);

    // ── Build fixture metadata ──
    const fixture = {
      _meta: {
        generated: new Date().toISOString(),
        source: "Alba production data (PII sanitized)",
        total_production_addresses: all.length,
        sample_size: sanitized.length,
        categories: {
          per_status: SAMPLE.PER_STATUS,
          duplicate_groups: dupSampled,
          empty_language: Math.min(emptyLang.length, SAMPLE.EMPTY_LANG),
          non_chinese: Math.min(nonChinese.length, SAMPLE.NON_CHINESE),
          overlap_buildings: overlapSampled,
        },
      },
      addresses: sanitized,
    };

    // ── Output ──
    const json = JSON.stringify(fixture, null, 2);
    console.log(`\n📦 Sample: ${sanitized.length} addresses (${(json.length / 1024).toFixed(0)} KB)`);
    console.log("\n%cTo save:", "font-weight:bold;");
    console.log("  copy(JSON.stringify(__albaSample, null, 2))");
    console.log("  Then paste into test/fixtures/production-sample.json\n");

    window.__albaSample = fixture;

    // Also try auto-download
    try {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "production-sample.json";
      a.click();
      URL.revokeObjectURL(url);
      console.log("✅ Auto-download triggered. Check your Downloads folder.");
    } catch (e) {
      console.log("⚠️ Auto-download failed. Use the copy() method above.");
    }

  } catch (err) {
    console.error("💥 Fatal:", err);
  }
})();
