// ═══════════════════════════════════════════════════════════
// ALBA TERRITORY CLEANUP — Pure Logic Module
//
// Zero side effects. No console, no fetch, no DOM.
// Every function takes data in, returns data out.
// Config is always an explicit parameter.
// ═══════════════════════════════════════════════════════════

export const norm = (s) => (s || "").toLowerCase().trim();

// ───────────────────────────────────────────────────────────
// Notes truncation — the API rejects notes above a certain
// length. Truncate at the last semicolon boundary before the
// limit, and append a marker so we know it was cut.
// ───────────────────────────────────────────────────────────
export function truncateNotes(notes, config) {
  const max = config.MAX_NOTES_LENGTH;
  if (!notes || !max || notes.length <= max) return notes;
  const marker = " [+truncated]";
  const cutAt = max - marker.length;
  // Try to cut at a semicolon boundary to avoid splitting a note mid-word
  const lastSemi = notes.lastIndexOf(";", cutAt);
  const breakPoint = lastSemi > cutAt * 0.5 ? lastSemi : cutAt;
  return notes.slice(0, breakPoint).trimEnd() + marker;
}

// ───────────────────────────────────────────────────────────
// Language discovery (pure filter — the API fetch is in the
// browser harness; this just classifies what came back)
// ───────────────────────────────────────────────────────────
export function filterChineseLanguages(allLanguages, config) {
  return allLanguages.filter((lang) => {
    const name = norm(lang.language || lang.name || "");
    return config.CHINESE_KEYWORDS.some((kw) => name.includes(kw));
  });
}

// ───────────────────────────────────────────────────────────
// Scoring: decides which copy to keep in a duplicate group
// ───────────────────────────────────────────────────────────
export function scoreEntry(a, config) {
  const chineseSet = new Set(config.CHINESE_LANGUAGE_IDS);
  const p = config.STATUS_PRIORITY[a.status] ?? config.DEFAULT_PRIORITY;
  let score = (10 - p) * 1000;
  if (chineseSet.has(a.language_id)) score += 500;
  if (a.full_name) score += 10;
  if (a.telephone) score += 50;
  if (a.notes) score += 10 + a.notes.length / 100;
  if (a.city) score += 5;
  if (a.postcode) score += 5;
  return score;
}

// ───────────────────────────────────────────────────────────
// Deduplication analysis
//
// Returns { actions: [...], totalLosers: N }
// Each action: { key, keeper, losers, mergeItems, newKeeperNotes }
// ───────────────────────────────────────────────────────────
export function analyzeDeduplication(addresses, config) {
  // Group by normalized address+suite
  const groups = new Map();
  for (const a of addresses) {
    const addr = norm(a.address);
    if (!addr) continue;
    const key = `${addr}|${norm(a.suite)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const actions = [];
  let totalLosers = 0;

  for (const [key, group] of groups) {
    if (group.length <= 1) continue;

    // Pick keeper (highest score)
    let bestIdx = 0;
    let bestScore = scoreEntry(group[0], config);
    for (let i = 1; i < group.length; i++) {
      const s = scoreEntry(group[i], config);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    }
    const keeper = group[bestIdx];
    const losers = group.filter((_, i) => i !== bestIdx);
    totalLosers += losers.length;

    // Collect unique notes/phones to merge into keeper
    const existing = (keeper.notes || "").trim();
    const seen = new Set(
      existing.toLowerCase().split(/[;,]/).map((s) => s.trim()).filter(Boolean)
    );
    const mergeItems = [];

    for (const loser of losers) {
      const phone = (loser.telephone || "").trim();
      if (phone && !seen.has(phone.toLowerCase())) {
        seen.add(phone.toLowerCase());
        mergeItems.push(`📞 ${phone}`);
      }
      const notes = (loser.notes || "").trim();
      if (notes && !seen.has(notes.toLowerCase())) {
        seen.add(notes.toLowerCase());
        mergeItems.push(notes);
      }
    }

    actions.push({
      key,
      keeper,
      losers,
      mergeItems,
      newKeeperNotes:
        mergeItems.length > 0
          ? truncateNotes([existing, ...mergeItems].filter(Boolean).join("; "), config)
          : null,
    });
  }

  return { actions, totalLosers };
}

// ───────────────────────────────────────────────────────────
// Suiteless-duplicate analysis
//
// Ported from the original Apps Script (lines 1010-1028):
// "If there are entries WITH suites, delete all entries WITHOUT suite"
//
// If "100 Main St" has entries with suites (1A, 2B, 3C) AND entries
// without any suite, the suiteless entries are redundant building-level
// records and should be marked Duplicate.
//
// DNC entries are exempt — they're sacred and never changed.
//
// Returns { actions: [...] }
// Each action: { address, suiteKeeper, suitelessLosers, mergeItems, newKeeperNotes }
// ───────────────────────────────────────────────────────────
export function analyzeSuitelessDuplicates(addresses, config) {
  // Group all addresses by normalized address only (ignore suite)
  const byAddress = new Map();
  for (const a of addresses) {
    const addr = norm(a.address);
    if (!addr) continue;
    if (!byAddress.has(addr)) byAddress.set(addr, []);
    byAddress.get(addr).push(a);
  }

  const actions = [];

  for (const [address, group] of byAddress) {
    const withSuite = group.filter((a) => !!norm(a.suite));
    const withoutSuite = group.filter((a) => !norm(a.suite));

    // Rule only applies when BOTH exist
    if (withSuite.length === 0 || withoutSuite.length === 0) continue;

    // DNC suiteless entries are exempt (sacred)
    const suitelessLosers = withoutSuite.filter(
      (a) => a.status !== config.STATUS.DNC
    );
    if (suitelessLosers.length === 0) continue;

    // Pick the best suite entry as keeper for note merging
    let bestIdx = 0;
    let bestScore = scoreEntry(withSuite[0], config);
    for (let i = 1; i < withSuite.length; i++) {
      const s = scoreEntry(withSuite[i], config);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    const suiteKeeper = withSuite[bestIdx];

    // Collect unique notes/phones from suiteless losers to merge
    const existing = (suiteKeeper.notes || "").trim();
    const seen = new Set(
      existing
        .toLowerCase()
        .split(/[;,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
    const mergeItems = [];

    for (const loser of suitelessLosers) {
      const phone = (loser.telephone || "").trim();
      if (phone && !seen.has(phone.toLowerCase())) {
        seen.add(phone.toLowerCase());
        mergeItems.push(`📞 ${phone}`);
      }
      const notes = (loser.notes || "").trim();
      if (notes && !seen.has(notes.toLowerCase())) {
        seen.add(notes.toLowerCase());
        mergeItems.push(notes);
      }
    }

    actions.push({
      address,
      suiteKeeper,
      suitelessLosers,
      mergeItems,
      newKeeperNotes:
        mergeItems.length > 0
          ? truncateNotes([existing, ...mergeItems].filter(Boolean).join("; "), config)
          : null,
    });
  }

  return { actions };
}

// ───────────────────────────────────────────────────────────
// Status analysis
// ───────────────────────────────────────────────────────────
export function analyzeStatuses(addresses, config) {
  const dupStatus = [];
  const notValid = [];
  const moved = [];

  for (const a of addresses) {
    if (a.status === config.STATUS.DUPLICATE) dupStatus.push(a);
    else if (a.status === config.STATUS.NOT_VALID) notValid.push(a);
    else if (a.status === config.STATUS.MOVED) moved.push(a);
  }

  return { dupStatus, notValid, moved };
}

// ───────────────────────────────────────────────────────────
// Language analysis
// ───────────────────────────────────────────────────────────
export function analyzeLanguages(addresses, config) {
  const chineseSet = new Set(config.CHINESE_LANGUAGE_IDS);
  const emptyLang = [];
  const nonChinese = [];

  for (const a of addresses) {
    const lid = a.language_id || 0;
    if (!lid || lid === 0) emptyLang.push(a);
    else if (!chineseSet.has(lid)) nonChinese.push(a);
  }

  return { emptyLang, nonChinese };
}

// ───────────────────────────────────────────────────────────
// Jitter analysis (which buildings need it)
// ───────────────────────────────────────────────────────────
export function analyzeJitter(addresses, config) {
  const precision = config.ROUNDING_PRECISION;
  const terrMap = new Map();

  for (const a of addresses) {
    const t = a.territory_number || "NONE";
    if (!terrMap.has(t)) terrMap.set(t, []);
    terrMap.get(t).push(a);
  }

  let totalPins = 0;
  const groups = [];

  for (const [terr, addrs] of terrMap) {
    const bMap = new Map();
    for (const a of addrs) {
      const lat = parseFloat(a.location_lat);
      const lng = parseFloat(a.location_lng);
      if (isNaN(lat) || isNaN(lng)) continue;
      const key = `${a.address}_${lat.toFixed(precision)}_${lng.toFixed(precision)}`;
      if (!bMap.has(key)) bMap.set(key, []);
      bMap.get(key).push(a);
    }
    for (const [, group] of bMap) {
      if (group.length > 1) {
        totalPins += group.length;
        groups.push({ address: group[0].address, territory: terr, units: group.length });
      }
    }
  }

  return { totalPins, groups };
}

// ───────────────────────────────────────────────────────────
// Compute jitter coordinates (pure math)
// Returns array of { id, new_lat, new_lng }
// ───────────────────────────────────────────────────────────
export function computeJitterCoords(addresses, config) {
  const precision = config.ROUNDING_PRECISION;
  const spacing = config.JITTER_SPACING;
  const threshSq = config.COLLISION_THRESHOLD ** 2;
  const startRad = (config.RADAR_START_DEG * Math.PI) / 180;
  const stepRad = (config.RADAR_STEP_DEG * Math.PI) / 180;
  const maxAttempts = config.RADAR_ATTEMPTS;

  const terrMap = new Map();
  for (const a of addresses) {
    const t = a.territory_number || "NONE";
    if (!terrMap.has(t)) terrMap.set(t, []);
    terrMap.get(t).push(a);
  }

  const changes = [];

  for (const [, addrs] of terrMap) {
    // Sort for deterministic output
    addrs.sort((a, b) => {
      const c = norm(a.address).localeCompare(norm(b.address));
      return c !== 0
        ? c
        : (a.suite || "").localeCompare(b.suite || "", undefined, { numeric: true });
    });

    const buildingMap = new Map();
    for (const a of addrs) {
      const lat = parseFloat(a.location_lat);
      const lng = parseFloat(a.location_lng);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90) continue;
      const key = `${a.address}_${lat.toFixed(precision)}_${lng.toFixed(precision)}`;
      if (!buildingMap.has(key))
        buildingMap.set(key, { anchorLat: lat, anchorLng: lng, entries: [] });
      buildingMap.get(key).entries.push(a);
    }

    const occupied = [];

    for (const [, building] of buildingMap) {
      const entries = building.entries;
      if (entries.length === 1) {
        occupied.push({ lat: parseFloat(entries[0].location_lat), lng: parseFloat(entries[0].location_lng) });
        continue;
      }

      const { anchorLat, anchorLng } = building;
      let bestAngle = startRad;

      for (let a = 0; a < maxAttempts; a++) {
        const angle = startRad + a * stepRad;
        const sinA = Math.sin(angle);
        const cosA = Math.cos(angle);
        let collision = false;

        for (let j = 1; j < entries.length && !collision; j++) {
          const off = j * spacing;
          const pLat = anchorLat + sinA * off;
          const pLng = anchorLng + cosA * off;
          for (const o of occupied) {
            if ((pLat - o.lat) ** 2 + (pLng - o.lng) ** 2 < threshSq) {
              collision = true; break;
            }
          }
        }
        if (!collision) { bestAngle = angle; break; }
      }

      const sinA = Math.sin(bestAngle);
      const cosA = Math.cos(bestAngle);

      for (let j = 0; j < entries.length; j++) {
        const off = j * spacing;
        const newLat = anchorLat + sinA * off;
        const newLng = anchorLng + cosA * off;
        if (j > 0) changes.push({ id: entries[j].id, new_lat: newLat, new_lng: newLng });
        occupied.push({ lat: newLat, lng: newLng });
      }
    }
  }

  return changes;
}

// ───────────────────────────────────────────────────────────
// Build a PUT payload from an address + overrides
// ───────────────────────────────────────────────────────────
export function makePayload(a, overrides = {}) {
  return {
    full_name: a.full_name,
    telephone: a.telephone,
    suite: a.suite,
    address: a.address,
    city: a.city,
    province: a.province,
    country: a.country,
    postcode: a.postcode,
    location_lat: a.location_lat,
    location_lng: a.location_lng,
    status: a.status,
    territory_id: a.territory_id,
    language_id: a.language_id,
    contacted_by_id: a.contacted_by_id || 0,
    contacted_ts: a.contacted_ts,
    notes: a.notes,
    notes_private: a.notes_private,
    is_gated: a.is_gated ? 1 : 0,
    ...overrides,
  };
}

// ───────────────────────────────────────────────────────────
// Build execution plan
//
// Merges all operations into a Map<id, planEntry> so each
// address gets at most one PUT. Returns array of plan entries.
//
// Each entry: { id, tags: Set<string>, payload: {...} }
// ───────────────────────────────────────────────────────────
export function buildPlan(addresses, dedup, statuses, languages, jitterChanges, config, suiteless) {
  const addrMap = new Map(addresses.map((a) => [a.id, a]));
  const plan = new Map();

  function getOrCreate(id) {
    if (!plan.has(id)) {
      const a = addrMap.get(id);
      if (!a) return null;
      plan.set(id, { id, tags: new Set(), payload: makePayload(a) });
    }
    return plan.get(id);
  }

  // 1. Dedup losers → status Duplicate
  const loserIds = new Set();
  for (const group of dedup.actions) {
    for (const loser of group.losers) {
      loserIds.add(loser.id);
      if (loser.status === config.STATUS.DUPLICATE) continue; // already correct
      const entry = getOrCreate(loser.id);
      if (entry) {
        entry.payload.status = config.STATUS.DUPLICATE;
        entry.tags.add("set-duplicate");
      }
    }
  }

  // 1b. Suiteless-duplicate losers → status Duplicate
  if (suiteless) {
    for (const group of suiteless.actions) {
      for (const loser of group.suitelessLosers) {
        loserIds.add(loser.id);
        if (loser.status === config.STATUS.DUPLICATE) continue;
        const entry = getOrCreate(loser.id);
        if (entry) {
          entry.payload.status = config.STATUS.DUPLICATE;
          entry.tags.add("set-duplicate-suiteless");
        }
      }
    }
  }

  // 2. Dedup keepers: merge notes
  for (const group of dedup.actions) {
    if (!group.newKeeperNotes) continue;
    const entry = getOrCreate(group.keeper.id);
    if (entry) {
      entry.payload.notes = group.newKeeperNotes;
      entry.tags.add("merge-notes");
    }
  }

  // 2b. Suiteless loser notes → merge into best suite keeper
  // Runs AFTER normal dedup note merging so we build on top of it
  if (suiteless) {
    for (const group of suiteless.actions) {
      if (group.mergeItems.length === 0) continue;
      const entry = getOrCreate(group.suiteKeeper.id);
      if (entry) {
        // Check what notes are already on this entry (may include dedup merges)
        const current = (entry.payload.notes || "").trim();
        const seen = new Set(
          current.toLowerCase().split(/[;,]/).map((s) => s.trim()).filter(Boolean)
        );
        const extra = group.mergeItems.filter(
          (item) => !seen.has(item.toLowerCase().trim())
        );
        if (extra.length > 0) {
          entry.payload.notes = truncateNotes(
            [current, ...extra].filter(Boolean).join("; "), config
          );
          entry.tags.add("merge-notes-suiteless");
        }
      }
    }
  }

  // 3. Stale Duplicate → New
  // Only for status=Duplicate addresses that are NOT confirmed losers
  for (const a of statuses.dupStatus) {
    if (loserIds.has(a.id)) continue;
    const entry = getOrCreate(a.id);
    if (entry) {
      entry.payload.status = config.STATUS.NEW;
      entry.tags.add("dup-to-new");
    }
  }

  // 4. Empty language → Chinese Mandarin
  for (const a of languages.emptyLang) {
    const entry = getOrCreate(a.id);
    if (entry) {
      entry.payload.language_id = config.DEFAULT_LANGUAGE_ID;
      entry.tags.add("set-language");
    }
  }

  // 5. Jitter coordinates
  for (const jc of jitterChanges) {
    const entry = getOrCreate(jc.id);
    if (entry) {
      entry.payload.location_lat = jc.new_lat;
      entry.payload.location_lng = jc.new_lng;
      entry.tags.add("jitter");
    }
  }

  // Remove no-ops
  for (const [id, entry] of plan) {
    const orig = addrMap.get(id);
    if (!orig) { plan.delete(id); continue; }

    const p = entry.payload;
    const unchanged =
      p.status === orig.status &&
      p.language_id === (orig.language_id || 0) &&
      p.notes === (orig.notes || null) &&
      p.location_lat === orig.location_lat &&
      p.location_lng === orig.location_lng;

    if (unchanged) plan.delete(id);
  }

  return [...plan.values()];
}
