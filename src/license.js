/**
 * npm マニフェストの license 表記を 1 つの文字列に正規化する。
 *
 * - "MIT"                         → "MIT"
 * - { type: "MIT", url: ... }     → "MIT"
 * - licenses: [{type:"MIT"},{type:"Apache-2.0"}] → "MIT OR Apache-2.0"（旧形式）
 * - 無し / 空                     → "UNKNOWN"
 */
export function normalizeLicense(manifest) {
  if (!manifest || typeof manifest !== 'object') return 'UNKNOWN';

  const single = licenseEntryToString(manifest.license);
  if (single) return single;

  const legacy = manifest.licenses;
  if (Array.isArray(legacy)) {
    const parts = legacy.map(licenseEntryToString).filter(Boolean);
    if (parts.length > 0) return parts.join(' OR ');
  } else {
    const one = licenseEntryToString(legacy);
    if (one) return one;
  }

  return 'UNKNOWN';
}

function licenseEntryToString(entry) {
  if (!entry) return '';
  if (typeof entry === 'string') return entry.trim();
  if (typeof entry === 'object' && typeof entry.type === 'string') return entry.type.trim();
  return '';
}
