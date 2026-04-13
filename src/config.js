// Default configuration for Alba cleanup operations.
// The browser script populates CHINESE_LANGUAGE_IDS at runtime
// by fetching from the API. Tests can override any value.

export const DEFAULT_CONFIG = {
  STATUS: {
    UNSPECIFIED: 0, NEW: 1, VALID: 2,
    DNC: 3, MOVED: 4, DUPLICATE: 5, NOT_VALID: 6,
  },
  STATUS_LABEL: {
    0: "Unspecified", 1: "New", 2: "Valid",
    3: "Do Not Call", 4: "Moved", 5: "Duplicate", 6: "Not Valid",
  },

  // Auto-populated at runtime; tests should set this explicitly
  CHINESE_LANGUAGE_IDS: [83, 5, 188, 258, 190, 4, 189, 73, 259],
  CHINESE_KEYWORDS: [
    "chinese", "mandarin", "cantonese", "hakka", "hokkien",
    "teochew", "fuzhou", "shanghainese", "taiwanese", "toisan",
    "wenzhou", "fukien",
  ],

  DEFAULT_LANGUAGE_ID: 4,
  DEFAULT_LANGUAGE_NAME: "Chinese Mandarin",

  // Keeper priority: lower = more important to preserve
  STATUS_PRIORITY: { 3: 0, 1: 1, 2: 2, 0: 3 },
  DEFAULT_PRIORITY: 9,

  // Jitter
  JITTER_SPACING: 0.000014,
  ROUNDING_PRECISION: 4,
  RADAR_START_DEG: 135,
  RADAR_STEP_DEG: -15,
  RADAR_ATTEMPTS: 24,
  COLLISION_THRESHOLD: 0.000014,

  // Notes field limit (API rejects >5000 chars with HTTP 400)
  MAX_NOTES_LENGTH: 4950,
};
