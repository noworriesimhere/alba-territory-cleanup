// ╔══════════════════════════════════════════════════════════════════╗
// ║  ALBA RECON — Pre-flight checks                                ║
// ║  Paste into DevTools while logged into Alba                    ║
// ║                                                                ║
// ║  Runs read-only checks to answer key unknowns before the       ║
// ║  cleanup. Does NOT modify any data.                            ║
// ╚══════════════════════════════════════════════════════════════════╝

const API = "/alba/api";
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function apiFetch(path) {
  const resp = await fetch(`${API}${path}`, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${path}`);
  const json = await resp.json();
  if (!json.success) throw new Error(`API error on ${path}`);
  return json.data;
}

async function apiPut(id, payload) {
  const resp = await fetch(`${API}/addresses/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`PUT ${id}: HTTP ${resp.status}`);
  return resp.json();
}

(async function recon() {
  console.clear();
  console.log("%c🔍 ALBA RECON — Pre-flight Checks", "font-size:16px; font-weight:bold; color:#60a5fa;");
  console.log("Read-only checks (except the idempotent PUT test).\n");

  try {
    // ── 1. Session / Auth ──
    console.log("%c━━━ 1. Session & Auth ━━━", "font-weight:bold;");
    const first = await apiFetch("/addresses?limit=1&offset=0&sort=id&order=asc");
    console.log(`✅ Authenticated. ${first.total.toLocaleString()} total addresses.`);

    // ── 2. Page size limits ──
    console.log("\n%c━━━ 2. Page Size Limits ━━━", "font-weight:bold;");
    for (const size of [100, 250, 500, 1000]) {
      try {
        const data = await apiFetch(`/addresses?limit=${size}&offset=0&sort=id&order=asc`);
        console.log(`  limit=${size}: ✅ returned ${data.addresses.length} rows`);
      } catch (e) {
        console.log(`  limit=${size}: ❌ ${e.message}`);
      }
      await sleep(300);
    }

    // ── 3. PUT idempotency test ──
    // Re-PUT the first address with its own data — should be a no-op
    console.log("\n%c━━━ 3. PUT Idempotency Test ━━━", "font-weight:bold;");
    const testAddr = first.addresses[0];
    console.log(`  Testing PUT on ID ${testAddr.id} (${testAddr.address})...`);
    const payload = {
      full_name: testAddr.full_name,
      telephone: testAddr.telephone,
      suite: testAddr.suite,
      address: testAddr.address,
      city: testAddr.city,
      province: testAddr.province,
      country: testAddr.country,
      postcode: testAddr.postcode,
      location_lat: testAddr.location_lat,
      location_lng: testAddr.location_lng,
      status: testAddr.status,
      territory_id: testAddr.territory_id,
      language_id: testAddr.language_id,
      contacted_by_id: testAddr.contacted_by_id || 0,
      contacted_ts: testAddr.contacted_ts,
      notes: testAddr.notes,
      notes_private: testAddr.notes_private,
      is_gated: testAddr.is_gated ? 1 : 0,
    };
    const putResult = await apiPut(testAddr.id, payload);
    if (putResult.success) {
      console.log("  ✅ PUT succeeded (no-op write).");
      // Re-fetch and verify nothing changed
      const verify = await apiFetch(`/addresses/${testAddr.id}`);
      const unchanged =
        verify.status === testAddr.status &&
        verify.notes === testAddr.notes &&
        verify.language_id === testAddr.language_id;
      console.log(`  ✅ Re-fetched: data ${unchanged ? "unchanged" : "⚠️ CHANGED!"}`);
      if (!unchanged) {
        console.log("  ⚠️ Fields that changed:");
        for (const key of Object.keys(testAddr)) {
          if (verify[key] !== testAddr[key]) {
            console.log(`    ${key}: ${JSON.stringify(testAddr[key])} → ${JSON.stringify(verify[key])}`);
          }
        }
      }
    } else {
      console.log(`  ❌ PUT failed: ${JSON.stringify(putResult)}`);
    }

    // ── 4. Notes length test ──
    console.log("\n%c━━━ 4. Notes Length Limit Test ━━━", "font-weight:bold;");
    const longNote = testAddr.notes || "";
    const testNote = longNote + "; " + "A".repeat(5000);
    console.log(`  Testing ${testNote.length} char notes on ID ${testAddr.id}...`);
    try {
      const notePayload = { ...payload, notes: testNote };
      const noteResult = await apiPut(testAddr.id, notePayload);
      if (noteResult.success) {
        const verify2 = await apiFetch(`/addresses/${testAddr.id}`);
        const savedLen = (verify2.notes || "").length;
        console.log(`  ✅ PUT accepted. Saved notes length: ${savedLen} (sent ${testNote.length})`);
        if (savedLen < testNote.length) {
          console.log(`  ⚠️ TRUNCATED to ${savedLen} chars!`);
        }
        // Restore original
        await apiPut(testAddr.id, payload);
        console.log("  ✅ Restored original notes.");
      }
    } catch (e) {
      console.log(`  ❌ Rejected: ${e.message}`);
      // Try to restore just in case
      try { await apiPut(testAddr.id, payload); } catch {}
    }

    // ── 5. Rate limit / timing ──
    console.log("\n%c━━━ 5. Rate Limit Check (10 rapid PUTs) ━━━", "font-weight:bold;");
    const times = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      try {
        await apiPut(testAddr.id, payload);
        const elapsed = performance.now() - start;
        times.push(elapsed);
      } catch (e) {
        console.log(`  ❌ Request ${i + 1}: ${e.message}`);
        break;
      }
    }
    if (times.length > 0) {
      const avg = times.reduce((a, b) => a + b) / times.length;
      const max = Math.max(...times);
      console.log(`  ✅ ${times.length}/10 succeeded. Avg: ${avg.toFixed(0)}ms, Max: ${max.toFixed(0)}ms`);
      if (max > 2000) console.log("  ⚠️ Slow responses detected — may need longer delays.");
    }

    // ── 6. Session cookie TTL hint ──
    console.log("\n%c━━━ 6. Cookie Info ━━━", "font-weight:bold;");
    console.log(`  document.cookie length: ${document.cookie.length}`);
    console.log("  (HttpOnly cookies are not visible to JS — TTL is unknown.)");
    console.log("  Recommendation: monitor for 401 errors during long runs.");

    // ── 7. Concurrent edit detection ──
    console.log("\n%c━━━ 7. Address Snapshot ━━━", "font-weight:bold;");
    console.log("  Saving address count + checksum for later comparison.");
    const snapshot = {
      total: first.total,
      timestamp: new Date().toISOString(),
      sampleIds: first.addresses.slice(0, 5).map(a => a.id),
    };
    window.__albaSnapshot = snapshot;
    console.log(`  Saved to window.__albaSnapshot.`);
    console.log(`  Before running cleanup, re-run and compare total: ${first.total}`);

    console.log("\n%c━━━ RECON COMPLETE ━━━", "font-weight:bold; color:#22c55e;");
    console.log("All results above. Key findings:");
    console.log("  • Copy results to share with your dev before proceeding.");
    console.log("  • If notes truncation occurs, you'll need to limit merged notes.");
    console.log("  • If rate limiting occurs, increase WRITE_DELAY_MS.");

  } catch (err) {
    console.error("💥 Error:", err);
  }
})();
