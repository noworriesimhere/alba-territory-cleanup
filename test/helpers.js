// Test helper: creates a fake Alba address with sensible defaults.
// Override any field by passing it in the opts object.

let _nextId = 1000;

export function makeAddr(opts = {}) {
  const id = opts.id ?? _nextId++;
  return {
    id,
    account_id: opts.account_id ?? 2515,
    territory_id: opts.territory_id ?? 94007,
    territory_number: opts.territory_number ?? "MS-1",
    created_ts: opts.created_ts ?? "2024-01-01T00:00:00Z",
    modified_ts: opts.modified_ts ?? "2024-06-01T00:00:00Z",
    created_by_id: 1,
    modified_by_id: 1,
    completed_ts: null,
    completed_by_id: 0,
    contacted_ts: opts.contacted_ts ?? null,
    contacted_by_id: opts.contacted_by_id ?? 0,
    location_lat: opts.location_lat ?? 40.75,
    location_lng: opts.location_lng ?? -73.87,
    geocode: 1,
    user_id: 0,
    status: opts.status ?? 1,  // New
    interest: 0,
    language_id: "language_id" in opts ? opts.language_id : 4,  // Chinese Mandarin
    language_name: opts.language_name ?? "Chinese Mandarin",
    full_name: opts.full_name ?? null,
    suite: opts.suite ?? null,
    address: opts.address ?? "123 Main St",
    city: opts.city ?? "Jackson Heights",
    province: opts.province ?? "NY",
    country: opts.country ?? "US",
    postcode: opts.postcode ?? "11372",
    telephone: opts.telephone ?? null,
    notes: opts.notes ?? null,
    notes_private: opts.notes_private ?? null,
    is_gated: opts.is_gated ?? false,
    territory_description: null,
    territory_completed_ts: null,
    coop_account_name: null,
  };
}

export function resetIdCounter(start = 1000) {
  _nextId = start;
}
