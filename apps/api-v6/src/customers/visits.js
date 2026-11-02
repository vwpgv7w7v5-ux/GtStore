const DEFAULT_DEBOUNCE_MS = 30 * 60 * 1000; // 30 min = same visit session

const nowIso = () => new Date().toISOString();

/**
 * Record a customer open (Mini App / bot / chat).
 * Debounces visitCount so rapid re-opens count as one visit.
 */
export function touchCustomerVisit(profile, options = {}) {
  if (!profile || typeof profile !== 'object') return profile;
  const ts = options.at || nowIso();
  const debounceMs = Number.isFinite(options.debounceMs)
    ? options.debounceMs
    : DEFAULT_DEBOUNCE_MS;

  if (!profile.createdAt) profile.createdAt = ts;
  if (!profile.firstSeenAt) {
    profile.firstSeenAt = profile.createdAt || profile.referredAt || ts;
  }

  const prev = profile.lastSeenAt || profile.updatedAt || null;
  const prevMs = prev ? Date.parse(prev) : 0;
  const nextMs = Date.parse(ts) || Date.now();
  let count = Number(profile.visitCount || 0);
  if (!Number.isFinite(count) || count < 0) count = 0;

  if (!prev || !prevMs || nextMs - prevMs >= debounceMs) {
    count += 1;
  } else if (count < 1) {
    count = 1;
  }

  profile.visitCount = count;
  profile.lastSeenAt = ts;
  profile.updatedAt = ts;
  return profile;
}
