#!/usr/bin/env node

// ╔══════════════════════════════════════════════════════════════════╗
// ║  BUILD BROWSER SCRIPT                                          ║
// ║  Combines src/config.js + src/analysis.js into a single        ║
// ║  paste-into-DevTools IIFE.                                     ║
// ║                                                                ║
// ║  Usage: node scripts/build-browser.js                          ║
// ║  Output: dist/alba-cleanup.js                                  ║
// ╚══════════════════════════════════════════════════════════════════╝

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), "utf-8");
}

// ── Strip ES module syntax from source files ──
function stripExports(code) {
  return code
    .replace(/^export\s+(const|function|class)\s/gm, "$1 ")
    .replace(/^export\s*\{[^}]*\}\s*;?\s*$/gm, "");
}

function stripImports(code) {
  return code.replace(/^import\s+.*$/gm, "");
}

// ── Read source modules ──
const configSrc = stripExports(read("src/config.js"));
const analysisSrc = stripExports(stripImports(read("src/analysis.js")));

// ── Browser harness (API calls, logging, execution engine) ──
const browserHarness = `
// ═══════════════════════════════════════════════════════════
// BROWSER HARNESS — API, logging, execution
// ═══════════════════════════════════════════════════════════

const DRY_RUN = true;  // ← flip to false when ready to execute

const CONFIG = {
  ...DEFAULT_CONFIG,
  API: "/alba/api",
  PAGE_SIZE: 500,
  FETCH_DELAY_MS: 200,
  WRITE_DELAY_MS: 350,
  BATCH_SIZE: 500,       // pause for confirmation every N writes
  CHINESE_LANGUAGE_IDS: [],  // auto-populated at runtime
};

const WAVE_DEFS = Object.freeze([
  {
    key: "dedup",
    title: "Wave 1: Deduplication",
    reviewLabel: "deduplication",
    tags: WAVE_TAGS.dedup,
  },
  {
    key: "dup-to-new",
    title: "Wave 2: Fix stale duplicates",
    reviewLabel: "stale duplicate fixes",
    tags: WAVE_TAGS.dupToNew,
  },
  {
    key: "language",
    title: "Wave 3: Fix blank languages",
    reviewLabel: "language fixes",
    tags: WAVE_TAGS.language,
  },
  {
    key: "jitter",
    title: "Wave 4: Fix map pins",
    reviewLabel: "map pin adjustments",
    tags: WAVE_TAGS.jitter,
  },
]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function buildDatasetFingerprint(addresses, plan) {
  const sample = [
    addresses.length,
    plan.length,
    ...addresses.slice(0, 10).map(a => \`\${a.id}:\${a.modified_ts || ""}\`),
    ...addresses.slice(-10).map(a => \`\${a.id}:\${a.modified_ts || ""}\`),
  ].join("|");

  let hash = 0;
  for (let i = 0; i < sample.length; i++) {
    hash = (hash * 31 + sample.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function getWaveEntries(plan, waveDef) {
  return plan.filter(entry => entryHasAnyTag(entry, waveDef.tags));
}

async function waitForManualContinue(message) {
  log("⏸️", message);
  await new Promise(resolve => {
    window.__albaContinue = () => {
      delete window.__albaContinue;
      resolve();
    };
  });
}

function log(icon, msg) {
  console.log(\`%c\${icon} \${msg}\`, "font-size:13px;");
}
function logSection(title) {
  console.log(
    \`\\n%c━━━ \${title} ━━━\`,
    "font-size:14px; font-weight:bold; color:#60a5fa;"
  );
}
function logWarn(msg) {
  console.log(\`%c⚠️ \${msg}\`, "font-size:13px; color:#f59e0b;");
}

async function apiFetch(path) {
  const resp = await fetch(\`\${CONFIG.API}\${path}\`, { credentials: "include" });
  if (resp.status === 401)
    throw new Error("Not authenticated — are you logged into Alba?");
  if (!resp.ok) throw new Error(\`HTTP \${resp.status} on \${path}\`);
  const json = await resp.json();
  if (!json.success)
    throw new Error(\`API error: \${json.error?.message || "unknown"}\`);
  return json.data;
}

async function apiPut(id, payload) {
  const resp = await fetch(\`\${CONFIG.API}/addresses/\${id}\`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(\`PUT \${id}: HTTP \${resp.status}\`);
  const json = await resp.json();
  if (!json.success)
    throw new Error(\`PUT \${id}: \${json.error?.message || "failed"}\`);
  return json.data;
}

// ═══════════════════════════════════════════════════════════
// STEP 1: DISCOVER LANGUAGES
// ═══════════════════════════════════════════════════════════
async function discoverLanguages() {
  logSection("STEP 1: Discovering Languages");
  let all = [];
  let offset = 0;
  while (true) {
    const data = await apiFetch(\`/languages\${offset ? \`?offset=\${offset}\` : ""}\`);
    const page = data.languages || data;
    if (!page || page.length === 0) break;
    all = all.concat(page);
    if (page.length < 50) break;
    offset += page.length;
    await sleep(CONFIG.FETCH_DELAY_MS);
  }
  const chinese = filterChineseLanguages(all, CONFIG);
  log("🌐", \`\${all.length} languages total, \${chinese.length} Chinese:\`);
  console.table(chinese.map(l => ({ id: l.id, language: l.language || l.name })));
  CONFIG.CHINESE_LANGUAGE_IDS = chinese.map(l => l.id);
  if (CONFIG.CHINESE_LANGUAGE_IDS.length === 0) {
    logWarn("No Chinese languages found! Falling back to ID 4 only.");
    CONFIG.CHINESE_LANGUAGE_IDS = [CONFIG.DEFAULT_LANGUAGE_ID];
  }
  log("📋", \`Chinese IDs: [\${CONFIG.CHINESE_LANGUAGE_IDS.join(", ")}]\`);
}

// ═══════════════════════════════════════════════════════════
// STEP 2: FETCH ALL ADDRESSES
// ═══════════════════════════════════════════════════════════
async function fetchAllAddresses() {
  logSection("STEP 2: Fetching All Addresses");
  let pageSize = CONFIG.PAGE_SIZE;
  let first;
  try {
    first = await apiFetch(\`/addresses?limit=\${pageSize}&offset=0&sort=id&order=asc\`);
  } catch (e) {
    if (e.message.includes("400")) {
      logWarn(\`limit=\${pageSize} rejected, falling back to 100\`);
      pageSize = 100;
      first = await apiFetch(\`/addresses?limit=\${pageSize}&offset=0&sort=id&order=asc\`);
    } else throw e;
  }
  const total = first.total;
  const actualPage = first.addresses.length;
  const pages = Math.ceil(total / actualPage);
  let all = [...first.addresses];
  log("📡", \`\${total.toLocaleString()} addresses, page size \${actualPage}, \${pages} pages\`);
  for (let p = 1; p < pages; p++) {
    await sleep(CONFIG.FETCH_DELAY_MS);
    const data = await apiFetch(\`/addresses?limit=\${pageSize}&offset=\${p * actualPage}&sort=id&order=asc\`);
    if (!data.addresses || data.addresses.length === 0) break;
    all = all.concat(data.addresses);
    if ((p + 1) % 10 === 0 || p === pages - 1)
      log("📥", \`Page \${p + 1}/\${pages} — \${all.length.toLocaleString()}\`);
  }
  log("✅", \`Fetched \${all.length.toLocaleString()} addresses\`);
  const idSet = new Set();
  let dupeIds = 0;
  for (const a of all) {
    if (idSet.has(a.id)) dupeIds++;
    idSet.add(a.id);
  }
  if (dupeIds > 0)
    logWarn(\`\${dupeIds} duplicate IDs detected — pagination overlap?\`);
  return all;
}

// ═══════════════════════════════════════════════════════════
// EXECUTION ENGINE — true per-wave payloads with per-wave resume
// ═══════════════════════════════════════════════════════════
async function executePlan(plan, addresses, waveDef, runContext) {
  const addrMap = new Map(addresses.map(a => [a.id, a]));
  const wave = getWaveEntries(plan, waveDef).map(entry => ({
    ...entry,
    payload: buildWavePayload(addrMap.get(entry.id), entry, waveDef.tags),
  }));

  if (wave.length === 0) {
    log("⏭️", "No entries in " + waveDef.reviewLabel + ".");
    return { ok: 0, fail: 0, aborted: false };
  }

  if (DRY_RUN) {
    log("🔒", "DRY RUN — " + wave.length + " " + waveDef.reviewLabel + " entries would be modified.");
    return { ok: 0, fail: 0, aborted: false };
  }

  const STORAGE_KEY = "alba_cleanup_progress:" + runContext.fingerprint + ":" + waveDef.key;
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  const startIdx = saved.waveSize === wave.length ? (saved.lastCompleted || 0) : 0;
  if (startIdx > 0) {
    log("🔄", "Resuming " + waveDef.reviewLabel + " from index " + startIdx + " (of " + wave.length + ")");
  }

  let ok = 0;
  let fail = 0;
  let consecutiveFails = 0;
  let aborted = false;
  const errors = [];

  for (let i = startIdx; i < wave.length; i++) {
    const op = wave[i];
    try {
      await apiPut(op.id, op.payload);
      ok++;
      consecutiveFails = 0;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lastCompleted: i + 1,
        waveSize: wave.length,
        timestamp: Date.now(),
      }));
    } catch (err) {
      fail++;
      consecutiveFails++;
      errors.push({ id: op.id, tags: [...op.tags].join(","), error: err.message });
      log("❌", "ID " + op.id + ": " + err.message);
      if (consecutiveFails >= 10) {
        log("🛑", "10 consecutive failures — aborting. Check window.__albaErrors.");
        window.__albaErrors = errors;
        aborted = true;
        break;
      }
    }

    if ((i + 1) % 100 === 0 || i === wave.length - 1)
      log("📝", (i + 1) + "/" + wave.length + " — " + ok + " ok, " + fail + " failed");

    if (CONFIG.BATCH_SIZE > 0 && (i + 1) % CONFIG.BATCH_SIZE === 0 && i < wave.length - 1) {
      await waitForManualContinue(
        "Paused " + waveDef.reviewLabel + " at " + (i + 1) + "/" + wave.length + ". Review progress, then call window.__albaContinue() to resume this wave."
      );
    }

    await sleep(CONFIG.WRITE_DELAY_MS);
  }

  if (fail === 0) localStorage.removeItem(STORAGE_KEY);

  logSection("WAVE COMPLETE");
  log("✅", "Success: " + ok);
  if (fail > 0) {
    log("❌", "Failed: " + fail);
    window.__albaErrors = errors;
    console.table(errors.slice(0, 50));
  }
  return { ok, fail, aborted };
}

// ═══════════════════════════════════════════════════════════
// PLAN LOGGING
// ═══════════════════════════════════════════════════════════
function logPlanSummary(plan) {
  const tagCounts = {};
  for (const entry of plan) {
    for (const tag of entry.tags) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }
  const tagLabels = {
    "set-duplicate": "Mark dedup losers → Duplicate (5)",
    "set-duplicate-suiteless": "Mark suiteless → Duplicate (5)",
    "merge-notes": "Merge notes/phones into keeper",
    "merge-notes-suiteless": "Merge suiteless notes into keeper",
    "dup-to-new": "Stale Duplicate → New (1)",
    "set-language": "Empty language → Chinese Mandarin",
    "jitter": "Adjust overlapping pin coordinates",
  };
  logSection("PLAN SUMMARY");
  console.table(
    Object.entries(tagCounts).map(([tag, count]) => ({
      operation: tagLabels[tag] || tag,
      addresses: count,
    }))
  );
  log("📋", \`Total PUT requests: \${plan.length.toLocaleString()}\`);
  const estMin = Math.ceil((plan.length * CONFIG.WRITE_DELAY_MS) / 60000);
  log("⏱️", \`Estimated time: ~\${estMin} min at \${CONFIG.WRITE_DELAY_MS}ms/req\`);
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════
(async function main() {
  console.clear();
  const mode = DRY_RUN ? "🔒 DRY RUN" : "⚡ LIVE";
  const color = DRY_RUN ? "#22c55e" : "#ef4444";
  console.log(
    \`%c╔══════════════════════════════════════════════╗\\n║   ALBA TERRITORY CLEANUP  v2.1               ║\\n║   \${mode}                              ║\\n╚══════════════════════════════════════════════╝\`,
    \`color:\${color}; font-size:14px; font-weight:bold;\`
  );

  try {
    await discoverLanguages();
    const addresses = await fetchAllAddresses();

    // Full backup before anything
    window.__albaBackup = addresses.map(a => ({ ...a }));
    log("💾", \`Backup saved to window.__albaBackup (\${addresses.length.toLocaleString()} addresses)\`);

    // Analysis
    logSection("ANALYSIS");
    const dedup = analyzeDeduplication(addresses, CONFIG);
    log("🔍", \`\${dedup.actions.length} duplicate groups, \${dedup.totalLosers} losers\`);
    console.table(
      dedup.actions.sort((a, b) => b.losers.length - a.losers.length).slice(0, 15)
        .map(a => ({
          address: a.keeper.address + (a.keeper.suite ? \` #\${a.keeper.suite}\` : ""),
          copies: a.losers.length + 1,
          keeper_id: a.keeper.id,
          keeper_status: CONFIG.STATUS_LABEL[a.keeper.status],
          will_merge: a.mergeItems.length,
        }))
    );

    const suiteless = analyzeSuitelessDuplicates(addresses, CONFIG);
    log("🏢", \`\${suiteless.actions.length} addresses with suiteless duplicates\`);
    if (suiteless.actions.length > 0)
      console.table(suiteless.actions.map(a => ({
        address: a.address,
        suiteless_losers: a.suitelessLosers.length,
        keeper_id: a.suiteKeeper.id,
        will_merge: a.mergeItems.length,
      })));

    const statuses = analyzeStatuses(addresses, CONFIG);
    log("📋", \`status=Duplicate: \${statuses.dupStatus.length}, Not Valid: \${statuses.notValid.length}, Moved: \${statuses.moved.length}\`);

    const languages = analyzeLanguages(addresses, CONFIG);
    log("🈳", \`Empty language: \${languages.emptyLang.length}, Non-Chinese: \${languages.nonChinese.length}\`);

    log("🧮", "Computing jitter coordinates...");
    const jitterChanges = computeJitterCoords(addresses, CONFIG);
    log("📍", \`\${jitterChanges.length} coordinates to adjust\`);

    // Build plan
    const plan = buildPlan(addresses, dedup, statuses, languages, jitterChanges, CONFIG, suiteless);
    logPlanSummary(plan);

    const runContext = {
      fingerprint: buildDatasetFingerprint(addresses, plan),
    };
    const waveCounts = WAVE_DEFS.map(wave => ({
      key: wave.key,
      title: wave.title,
      entries: getWaveEntries(plan, wave).length,
    }));

    // Store for inspection
    window.__albaPlan = plan;
    window.__albaAddresses = addresses;
    window.__albaAnalysis = {
      dedup,
      suiteless,
      statuses,
      languages,
      jitterChanges,
    };
    window.__albaWaves = waveCounts;
    window.__albaRunWave = async (key) => {
      const wave = WAVE_DEFS.find(item => item.key === key);
      if (!wave) throw new Error("Unknown wave: " + key);
      return executePlan(plan, addresses, wave, runContext);
    };

    if (DRY_RUN) {
      logSection("DRY RUN COMPLETE");
      log("🔒", "No changes made. Inspect the plan:");
      log("💡", "  __albaPlan                                         — full plan array");
      log("💡", "  __albaAnalysis                                     — exact analysis objects");
      log("💡", "  __albaWaves                                        — per-wave unique PUT counts");
      log("💡", "  __albaPlan.filter(p => p.tags.has('set-duplicate')) — dedup losers");
      log("💡", "  __albaPlan.filter(p => p.tags.has('set-duplicate-suiteless')) — suiteless losers");
      log("💡", "  __albaPlan.filter(p => p.tags.has('dup-to-new'))   — stale dup→new");
      log("💡", "  __albaPlan.filter(p => p.tags.has('jitter'))       — jitter");
      log("💡", "  __albaPlan.filter(p => p.tags.has('merge-notes'))  — note merges");
      log("💡", "Flip DRY_RUN to false and re-run to execute.");
      log("💡", "");
      log("💡", "── OPTIONAL MANUAL WAVE EXECUTION ──");
      log("💡", "window.__albaRunWave('dedup')");
      log("💡", "window.__albaRunWave('dup-to-new')");
      log("💡", "window.__albaRunWave('language')");
      log("💡", "window.__albaRunWave('jitter')");
    } else {
      const wavesToRun = WAVE_DEFS.filter(wave => getWaveEntries(plan, wave).length > 0);

      for (let i = 0; i < wavesToRun.length; i++) {
        const wave = wavesToRun[i];
        const nextWave = wavesToRun[i + 1];

        logSection("EXECUTING — " + wave.title);
        const result = await executePlan(plan, addresses, wave, runContext);

        if (result.fail > 0 || result.aborted) {
          logSection("EXECUTION STOPPED");
          log("🛑", "Stopped after " + wave.reviewLabel + ". Review the errors before continuing.");
          break;
        }

        if (nextWave) {
          logSection("PAUSED FOR REVIEW");
          await waitForManualContinue(
            "Review " + wave.reviewLabel + " in Alba, then call window.__albaContinue() to start " + nextWave.title + "."
          );
        }
      }
    }
  } catch (err) {
    console.error("💥 Fatal error:", err);
  }
})();
`;

// ── Assemble the final IIFE ──
const output = `// ╔══════════════════════════════════════════════════════════════════╗
// ║  ALBA TERRITORY CLEANUP — Browser Script  v2.1                ║
// ║  Auto-generated by scripts/build-browser.js                   ║
// ║  DO NOT EDIT — modify src/ files and rebuild instead.         ║
// ║                                                               ║
// ║  Paste into DevTools while logged into Alba.                  ║
// ╚══════════════════════════════════════════════════════════════════╝
(function() {
"use strict";

// ── src/config.js ──
${configSrc.trim()}

// ── src/analysis.js ──
${analysisSrc.trim()}

// ── Browser harness ──
${browserHarness.trim()}

})();
`;

// ── Write output ──
const distDir = resolve(ROOT, "dist");
mkdirSync(distDir, { recursive: true });
const outPath = resolve(distDir, "alba-cleanup.js");
writeFileSync(outPath, output, "utf-8");

const lines = output.split("\n").length;
const kb = (Buffer.byteLength(output) / 1024).toFixed(1);
console.log(`✅ Built dist/alba-cleanup.js (${lines} lines, ${kb} KB)`);
