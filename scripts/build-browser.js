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

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// EXECUTION ENGINE — wave-based with resume
// ═══════════════════════════════════════════════════════════
async function executePlan(plan, addresses, waveFilter) {
  const wave = waveFilter ? plan.filter(waveFilter) : plan;
  if (wave.length === 0) {
    log("⏭️", "No entries in this wave.");
    return { ok: 0, fail: 0 };
  }

  if (DRY_RUN) {
    log("🔒", \`DRY RUN — \${wave.length} entries would be modified.\`);
    return { ok: 0, fail: 0 };
  }

  // Resume support
  const STORAGE_KEY = "alba_cleanup_progress";
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  const startIdx = saved.lastCompleted || 0;
  if (startIdx > 0) {
    log("🔄", \`Resuming from index \${startIdx} (of \${wave.length})\`);
  }

  let ok = 0;
  let fail = 0;
  let consecutiveFails = 0;
  const errors = [];

  for (let i = startIdx; i < wave.length; i++) {
    const op = wave[i];
    try {
      await apiPut(op.id, op.payload);
      ok++;
      consecutiveFails = 0;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        lastCompleted: i + 1,
        timestamp: Date.now(),
      }));
    } catch (err) {
      fail++;
      consecutiveFails++;
      errors.push({ id: op.id, tags: [...op.tags].join(","), error: err.message });
      log("❌", \`ID \${op.id}: \${err.message}\`);
      if (consecutiveFails >= 10) {
        log("🛑", "10 consecutive failures — aborting. Check window.__albaErrors.");
        window.__albaErrors = errors;
        break;
      }
    }

    if ((i + 1) % 100 === 0 || i === wave.length - 1)
      log("📝", \`\${i + 1}/\${wave.length} — \${ok} ok, \${fail} failed\`);

    // Batch pause
    if (CONFIG.BATCH_SIZE > 0 && (i + 1) % CONFIG.BATCH_SIZE === 0 && i < wave.length - 1) {
      log("⏸️", \`Pausing at \${i + 1}. Call window.__albaContinue() to resume.\`);
      await new Promise(resolve => { window.__albaContinue = resolve; });
    }

    await sleep(CONFIG.WRITE_DELAY_MS);
  }

  if (fail === 0) localStorage.removeItem(STORAGE_KEY);

  logSection("WAVE COMPLETE");
  log("✅", \`Success: \${ok}\`);
  if (fail > 0) {
    log("❌", \`Failed: \${fail}\`);
    window.__albaErrors = errors;
    console.table(errors.slice(0, 50));
  }
  return { ok, fail };
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

    // Store for inspection
    window.__albaPlan = plan;
    window.__albaAddresses = addresses;

    if (DRY_RUN) {
      logSection("DRY RUN COMPLETE");
      log("🔒", "No changes made. Inspect the plan:");
      log("💡", "  __albaPlan                                         — full plan array");
      log("💡", "  __albaPlan.filter(p => p.tags.has('set-duplicate')) — dedup losers");
      log("💡", "  __albaPlan.filter(p => p.tags.has('set-duplicate-suiteless')) — suiteless losers");
      log("💡", "  __albaPlan.filter(p => p.tags.has('dup-to-new'))   — stale dup→new");
      log("💡", "  __albaPlan.filter(p => p.tags.has('jitter'))       — jitter");
      log("💡", "  __albaPlan.filter(p => p.tags.has('merge-notes'))  — note merges");
      log("💡", "Flip DRY_RUN to false and re-run to execute.");
      log("💡", "");
      log("💡", "── WAVE EXECUTION (when ready) ──");
      log("💡", "Wave 1 (dedup):    executePlan(plan, addresses, p => p.tags.has('set-duplicate') || p.tags.has('set-duplicate-suiteless') || p.tags.has('merge-notes') || p.tags.has('merge-notes-suiteless'))");
      log("💡", "Wave 2 (dup→new):  executePlan(plan, addresses, p => p.tags.has('dup-to-new'))");
      log("💡", "Wave 3 (language):  executePlan(plan, addresses, p => p.tags.has('set-language'))");
      log("💡", "Wave 4 (jitter):   executePlan(plan, addresses, p => p.tags.has('jitter'))");
    } else {
      logSection("EXECUTING — WAVE 1: Deduplication");
      await executePlan(plan, addresses,
        p => p.tags.has("set-duplicate") || p.tags.has("set-duplicate-suiteless") || p.tags.has("merge-notes") || p.tags.has("merge-notes-suiteless"));

      logSection("EXECUTING — WAVE 2: Dup→New");
      await executePlan(plan, addresses, p => p.tags.has("dup-to-new"));

      logSection("EXECUTING — WAVE 3: Language");
      await executePlan(plan, addresses, p => p.tags.has("set-language"));

      logSection("EXECUTING — WAVE 4: Jitter");
      await executePlan(plan, addresses, p => p.tags.has("jitter"));
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
