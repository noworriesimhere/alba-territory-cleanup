// ╔══════════════════════════════════════════════════════════════════╗
// ║  ALBA DRY-RUN REPORT GENERATOR                                 ║
// ║  Paste into DevTools AFTER running the dry-run.                ║
// ║  Reads __albaPlan and __albaAddresses, generates a Markdown    ║
// ║  report you can copy and share with anyone.                    ║
// ║                                                                ║
// ║  Usage:  copy(__albaReport)   — copies markdown to clipboard   ║
// ╚══════════════════════════════════════════════════════════════════╝

(function generateReport() {
  if (!window.__albaPlan || !window.__albaAddresses) {
    console.error("❌ Run the dry-run first! __albaPlan and __albaAddresses are not set.");
    return;
  }

  const plan = window.__albaPlan;
  const addrs = window.__albaAddresses;
  const addrMap = new Map(addrs.map(a => [a.id, a]));

  const STATUS_LABEL = {
    0: "Unspecified", 1: "New", 2: "Valid",
    3: "Do Not Call", 4: "Moved", 5: "Duplicate", 6: "Not Valid",
  };

  const now = new Date().toLocaleString();
  const lines = [];
  const ln = (s = "") => lines.push(s);

  // ── Helpers ──
  const fmt = (a) => {
    let s = a.address || "(no address)";
    if (a.suite) s += ` #${a.suite}`;
    return s;
  };
  const statusOf = (code) => STATUS_LABEL[code] || `Unknown (${code})`;
  const territory = (a) => a.territory_number || "—";

  // ── Categorize plan entries ──
  const dedupLosers = [];
  const suitelessLosers = [];
  const noteMerges = [];
  const suitelessNoteMerges = [];
  const dupToNew = [];
  const langFixes = [];
  const jitterFixes = [];

  for (const entry of plan) {
    if (entry.tags.has("set-duplicate")) dedupLosers.push(entry);
    if (entry.tags.has("set-duplicate-suiteless")) suitelessLosers.push(entry);
    if (entry.tags.has("merge-notes")) noteMerges.push(entry);
    if (entry.tags.has("merge-notes-suiteless")) suitelessNoteMerges.push(entry);
    if (entry.tags.has("dup-to-new")) dupToNew.push(entry);
    if (entry.tags.has("set-language")) langFixes.push(entry);
    if (entry.tags.has("jitter")) jitterFixes.push(entry);
  }

  // ── Group dedup losers by their keeper ──
  // We need to reconstruct which losers go with which keeper.
  // Losers share the same normalized address+suite as their keeper.
  const norm = s => (s || "").toLowerCase().trim();
  const dedupGroups = new Map(); // key → { keeper entry (if in plan), loser entries }

  // First pass: identify all loser IDs
  const loserIds = new Set(dedupLosers.map(e => e.id));
  const suitelessLoserIds = new Set(suitelessLosers.map(e => e.id));

  // Group all addresses by normalized key
  const addrGroups = new Map();
  for (const a of addrs) {
    const addr = norm(a.address);
    if (!addr) continue;
    const key = `${addr}|${norm(a.suite)}`;
    if (!addrGroups.has(key)) addrGroups.set(key, []);
    addrGroups.get(key).push(a);
  }

  // Build dedup group display data
  const dedupGroupDisplay = [];
  for (const [key, group] of addrGroups) {
    const groupLosers = group.filter(a => loserIds.has(a.id));
    if (groupLosers.length === 0) continue;
    const keeper = group.find(a => !loserIds.has(a.id)) || group[0];
    const keeperPlanEntry = plan.find(e => e.id === keeper.id);
    dedupGroupDisplay.push({
      key, keeper, losers: groupLosers,
      newNotes: keeperPlanEntry?.payload?.notes || null,
      oldNotes: keeper.notes,
    });
  }
  dedupGroupDisplay.sort((a, b) => b.losers.length - a.losers.length);

  // Build suiteless group display
  const suitelessGroupDisplay = [];
  const addrOnlyGroups = new Map();
  for (const a of addrs) {
    const addr = norm(a.address);
    if (!addr) continue;
    if (!addrOnlyGroups.has(addr)) addrOnlyGroups.set(addr, []);
    addrOnlyGroups.get(addr).push(a);
  }
  for (const [addr, group] of addrOnlyGroups) {
    const groupLosers = group.filter(a => suitelessLoserIds.has(a.id));
    if (groupLosers.length === 0) continue;
    const suitedEntries = group.filter(a => !!norm(a.suite));
    suitelessGroupDisplay.push({
      address: group[0].address,
      losers: groupLosers,
      suitedCount: suitedEntries.length,
    });
  }
  suitelessGroupDisplay.sort((a, b) => b.losers.length - a.losers.length);

  // ════════════════════════════════════════════════════════
  // BUILD THE REPORT
  // ════════════════════════════════════════════════════════

  ln("# Alba Territory Cleanup — Proposed Changes");
  ln();
  ln(`**Generated:** ${now}`);
  ln(`**Total addresses in Alba:** ${addrs.length.toLocaleString()}`);
  ln(`**Total addresses that will be changed:** ${plan.length.toLocaleString()}`);
  ln(`**Addresses left unchanged:** ${(addrs.length - plan.length).toLocaleString()}`);
  ln();
  ln("> ⚠️ This is a **dry run** report. No changes have been made yet.");
  ln("> Every change below can be reviewed before anything happens.");
  ln();

  // ── Summary table ──
  ln("## Summary");
  ln();
  ln("| What | Count | Explanation |");
  ln("|------|------:|-------------|");
  ln(`| Duplicate copies removed | ${dedupLosers.length.toLocaleString()} | Same address + same apartment — extra copies marked as "Duplicate" |`);
  ln(`| Building-level duplicates | ${suitelessLosers.length.toLocaleString()} | Address exists with apartment numbers, so the copy without an apartment is redundant |`);
  ln(`| Notes/phones merged into keeper | ${noteMerges.length + suitelessNoteMerges.length} | Useful info from duplicates is saved onto the kept copy |`);
  ln(`| Stale "Duplicate" → "New" | ${dupToNew.length.toLocaleString()} | These were marked Duplicate before but have no actual duplicate — restored to New |`);
  ln(`| Language set to Chinese Mandarin | ${langFixes.length.toLocaleString()} | Addresses with a blank language field — set to the congregation default |`);
  ln(`| Map pin locations adjusted | ${jitterFixes.length.toLocaleString()} | Apartments at the same GPS point get spread out so they're clickable on the map |`);
  ln();

  // ── Wave breakdown ──
  ln("## Execution Plan (4 Waves)");
  ln();
  ln("We do this in separate waves so we can check each one before moving on.");
  ln();
  const wave1 = dedupLosers.length + suitelessLosers.length + noteMerges.length + suitelessNoteMerges.length;
  ln(`1. **Wave 1 — Deduplication** (${wave1.toLocaleString()} changes, ~${Math.ceil(wave1 * 350 / 60000)} min)`);
  ln("   - Marks duplicate copies as "Duplicate"");
  ln("   - Saves any useful notes or phone numbers onto the kept copy");
  ln();
  ln(`2. **Wave 2 — Fix stale duplicates** (${dupToNew.length.toLocaleString()} changes, ~${Math.ceil(dupToNew.length * 350 / 60000)} min)`);
  ln("   - Addresses that were previously marked Duplicate but have no actual duplicate");
  ln();
  ln(`3. **Wave 3 — Fix blank languages** (${langFixes.length.toLocaleString()} changes, ~${Math.ceil(langFixes.length * 350 / 60000)} min)`);
  ln("   - Sets blank language fields to Chinese Mandarin");
  ln();
  ln(`4. **Wave 4 — Fix map pins** (${jitterFixes.length.toLocaleString()} changes, ~${Math.ceil(jitterFixes.length * 350 / 60000)} min)`);
  ln("   - Spreads overlapping map pins so each apartment is clickable");
  ln();

  // ── Safety guarantees ──
  ln("## Safety Guarantees");
  ln();
  ln("- ✅ **No address is ever deleted** — only fields like status, notes, and coordinates change");
  ln("- ✅ **Do Not Call is sacred** — DNC addresses are never changed to a different status");
  ln("- ✅ **Full backup taken** before any changes (can be restored if needed)");
  ln("- ✅ **Each wave pauses** for human confirmation before continuing");
  ln("- ✅ **Auto-stops** if 10 errors occur in a row");
  ln();

  // ════════════════════════════════════════════════════════
  // WAVE 1 DETAIL: Deduplication
  // ════════════════════════════════════════════════════════
  ln("---");
  ln("## Wave 1: Deduplication — Detailed Changes");
  ln();

  if (dedupGroupDisplay.length > 0) {
    ln("### Exact-match duplicates");
    ln();
    ln(`Found **${dedupGroupDisplay.length}** addresses with multiple copies.`);
    ln();

    // Show top 30 groups in detail, summarize the rest
    const DETAIL_LIMIT = 30;
    const showDetailed = dedupGroupDisplay.slice(0, DETAIL_LIMIT);
    const remaining = dedupGroupDisplay.slice(DETAIL_LIMIT);

    for (const group of showDetailed) {
      const k = group.keeper;
      ln(`#### 📍 ${fmt(k)} — ${territory(k)}`);
      ln();
      ln(`**Keeping** (ID ${k.id}): status = ${statusOf(k.status)}, notes = "${k.notes || "—"}"`)
      if (group.newNotes && group.newNotes !== k.notes) {
        ln();
        ln(`**Updated notes after merge:** "${group.newNotes}"`);
      }
      ln();
      ln("| # | ID | Before Status | Notes | Phone |");
      ln("|---|---:|---------------|-------|-------|");
      for (let i = 0; i < group.losers.length; i++) {
        const l = group.losers[i];
        ln(`| ${i + 1} | ${l.id} | ${statusOf(l.status)} → **Duplicate** | ${l.notes || "—"} | ${l.telephone || "—"} |`);
      }
      ln();
    }

    if (remaining.length > 0) {
      ln(`<details><summary>📋 ${remaining.length} more duplicate groups (click to expand)</summary>`);
      ln();
      for (const group of remaining) {
        const k = group.keeper;
        ln(`- **${fmt(k)}** (${territory(k)}): keeping ID ${k.id}, marking ${group.losers.length} duplicate${group.losers.length > 1 ? "s" : ""}`);
      }
      ln();
      ln("</details>");
      ln();
    }
  }

  if (suitelessGroupDisplay.length > 0) {
    ln("### Building-level duplicates (no apartment number)");
    ln();
    ln("These addresses have entries **with** apartment numbers (1A, 2B, etc.) and also");
    ln("entries **without** an apartment number. The no-apartment copies are redundant");
    ln("because the building is already covered by the individual apartment entries.");
    ln();

    for (const group of suitelessGroupDisplay) {
      ln(`- **${group.address}**: ${group.losers.length} no-apartment entr${group.losers.length > 1 ? "ies" : "y"} → Duplicate (building has ${group.suitedCount} apartments)`);
      for (const l of group.losers) {
        ln(`  - ID ${l.id} (was ${statusOf(l.status)})`);
      }
    }
    ln();
  }

  // ════════════════════════════════════════════════════════
  // WAVE 2 DETAIL: Dup→New
  // ════════════════════════════════════════════════════════
  if (dupToNew.length > 0) {
    ln("---");
    ln("## Wave 2: Stale Duplicates Restored to "New"");
    ln();
    ln("These addresses are currently marked as "Duplicate" but they don't actually");
    ln("have any duplicate. They were probably marked by accident or during a previous");
    ln("cleanup. We're restoring them to "New" so they show up in territory assignments.");
    ln();

    const SHOW_LIMIT = 50;
    const shown = dupToNew.slice(0, SHOW_LIMIT);

    ln("| # | ID | Address | Territory | Current Status → |");
    ln("|---|---:|---------|-----------|------------------|");
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const a = addrMap.get(e.id);
      ln(`| ${i + 1} | ${e.id} | ${fmt(a)} | ${territory(a)} | Duplicate → **New** |`);
    }
    if (dupToNew.length > SHOW_LIMIT) {
      ln();
      ln(`*…and ${dupToNew.length - SHOW_LIMIT} more.*`);
    }
    ln();
  }

  // ════════════════════════════════════════════════════════
  // WAVE 3 DETAIL: Language
  // ════════════════════════════════════════════════════════
  if (langFixes.length > 0) {
    ln("---");
    ln("## Wave 3: Blank Language → Chinese Mandarin");
    ln();
    ln("These addresses have no language set. Since this is a Chinese Mandarin");
    ln("congregation, we're setting them to the correct language.");
    ln();

    const SHOW_LIMIT = 30;
    const shown = langFixes.slice(0, SHOW_LIMIT);

    ln("| # | ID | Address | Territory |");
    ln("|---|---:|---------|-----------|");
    for (let i = 0; i < shown.length; i++) {
      const e = shown[i];
      const a = addrMap.get(e.id);
      ln(`| ${i + 1} | ${e.id} | ${fmt(a)} | ${territory(a)} |`);
    }
    if (langFixes.length > SHOW_LIMIT) {
      ln();
      ln(`*…and ${langFixes.length - SHOW_LIMIT} more.*`);
    }
    ln();
  }

  // ════════════════════════════════════════════════════════
  // WAVE 4 DETAIL: Jitter
  // ════════════════════════════════════════════════════════
  if (jitterFixes.length > 0) {
    ln("---");
    ln("## Wave 4: Map Pin Adjustments");
    ln();
    ln(`**${jitterFixes.length.toLocaleString()} addresses** will have their map pins spread`);
    ln("apart slightly. This doesn't change the actual address — it just makes");
    ln("the pins clickable on the map instead of being stacked on top of each other.");
    ln();
    ln("Pin movements are tiny — about 1.5 meters — invisible at normal zoom but");
    ln("enough to make each apartment clickable.");
    ln();

    // Group by building for a summary
    const buildingCounts = new Map();
    for (const e of jitterFixes) {
      const a = addrMap.get(e.id);
      const bldg = `${a.address} (${territory(a)})`;
      buildingCounts.set(bldg, (buildingCounts.get(bldg) || 0) + 1);
    }
    const sortedBuildings = [...buildingCounts.entries()].sort((a, b) => b[1] - a[1]);

    ln("| Building | Territory | Pins adjusted |");
    ln("|----------|-----------|--------------|");
    for (const [bldg, count] of sortedBuildings.slice(0, 30)) {
      ln(`| ${bldg} | ${count} |`);
    }
    if (sortedBuildings.length > 30) {
      ln();
      ln(`*…and ${sortedBuildings.length - 30} more buildings.*`);
    }
    ln();
  }

  // ── DNC verification ──
  ln("---");
  ln("## Do Not Call Verification");
  ln();
  const dncAddrs = addrs.filter(a => a.status === 3);
  const dncInPlan = plan.filter(e => {
    const a = addrMap.get(e.id);
    return a && a.status === 3;
  });
  const dncStatusChanged = dncInPlan.filter(e => e.payload.status !== 3);
  ln(`- Total DNC addresses: **${dncAddrs.length}**`);
  ln(`- DNC addresses touched by the plan: **${dncInPlan.length}** (only for note merges or jitter — never status changes)`);
  ln(`- DNC addresses with status changed: **${dncStatusChanged.length}** ${dncStatusChanged.length === 0 ? "✅ None — DNC is safe" : "⚠️ THIS SHOULD BE ZERO"}`);
  ln();

  // ── Footer ──
  ln("---");
  ln();
  ln("*Report generated from dry-run data. To proceed, review this report,*");
  ln("*then flip `DRY_RUN = false` in the script and re-run.*");

  const report = lines.join("\n");
  window.__albaReport = report;
  console.log("%c✅ Report generated!", "font-size:14px; font-weight:bold; color:#22c55e;");
  console.log(`${lines.length} lines, ${(report.length / 1024).toFixed(0)} KB`);
  console.log("");
  console.log("%cTo copy:", "font-weight:bold;");
  console.log("  copy(__albaReport)");
  console.log("");
  console.log("Then paste into any text editor and save as .md");
  console.log("Or paste into GitHub, Notion, Google Docs — anything that renders Markdown.");
})();
