export function selectLeastConn(pool, activeCounts) {
  let best = pool[0];
  let bestCount = activeCounts.get(key(pool[0])) ?? 0;
  for (let i = 1; i < pool.length; i++) {
    const count = activeCounts.get(key(pool[i])) ?? 0;
    if (count < bestCount) {
      best = pool[i];
      bestCount = count;
    }
  }
  return best;
}

function key(entry) {
  const pid = entry.providerId ?? entry.provider;
  return `${pid}:${entry.model}`;
}

export { key as entryKey };
