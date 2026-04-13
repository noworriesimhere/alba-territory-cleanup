// ╔══════════════════════════════════════════════════════════════════╗
// ║  ALBA RECON — Notes Length Binary Search                       ║
// ║  Paste into DevTools while logged into Alba                    ║
// ║                                                                ║
// ║  Finds the exact max notes length the API accepts.             ║
// ║  Uses the same test address as recon.js. Restores original.    ║
// ╚══════════════════════════════════════════════════════════════════╝

const API = "/alba/api";

async function apiFetch(path) {
  const resp = await fetch(`${API}${path}`, { credentials: "include" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.success) throw new Error("API error");
  return json.data;
}

async function apiPut(id, payload) {
  const resp = await fetch(`${API}/addresses/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  return { ok: resp.ok, status: resp.status };
}

(async function findNotesLimit() {
  console.clear();
  console.log("%c🔍 Notes Length Binary Search", "font-size:16px; font-weight:bold; color:#60a5fa;");

  const first = await apiFetch("/addresses?limit=1&offset=0&sort=id&order=asc");
  const addr = first.addresses[0];
  const originalNotes = addr.notes;

  const payload = {
    full_name: addr.full_name, telephone: addr.telephone, suite: addr.suite,
    address: addr.address, city: addr.city, province: addr.province,
    country: addr.country, postcode: addr.postcode,
    location_lat: addr.location_lat, location_lng: addr.location_lng,
    status: addr.status, territory_id: addr.territory_id,
    language_id: addr.language_id, contacted_by_id: addr.contacted_by_id || 0,
    contacted_ts: addr.contacted_ts, notes: addr.notes,
    notes_private: addr.notes_private, is_gated: addr.is_gated ? 1 : 0,
  };

  let lo = 1;
  let hi = 10000;
  console.log(`Testing ID ${addr.id} (${addr.address}). Original notes: ${(originalNotes || "").length} chars`);
  console.log(`Binary searching between ${lo} and ${hi}...\n`);

  // First check if 10000 works (no limit)
  const bigTest = await apiPut(addr.id, { ...payload, notes: "X".repeat(hi) });
  if (bigTest.ok) {
    console.log(`✅ ${hi} chars accepted — limit is ≥${hi} or none.`);
    await apiPut(addr.id, { ...payload, notes: originalNotes });
    return;
  }

  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const testNotes = "X".repeat(mid);
    const result = await apiPut(addr.id, { ...payload, notes: testNotes });
    const icon = result.ok ? "✅" : "❌";
    console.log(`  ${icon} ${mid} chars → HTTP ${result.status}`);
    if (result.ok) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  // Restore original
  await apiPut(addr.id, { ...payload, notes: originalNotes });

  console.log(`\n%c━━━ RESULT ━━━`, "font-weight:bold; color:#22c55e;");
  console.log(`Max notes length: ${lo} chars (${lo + 1} fails)`);
  console.log(`\nSafe limit for code: ${lo - 50} chars (with buffer)`);
  window.__albaNotesLimit = lo;
})();
