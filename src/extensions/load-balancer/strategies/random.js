export function selectRandom(pool) {
  return pool[Math.floor(Math.random() * pool.length)];
}

export function selectWeighted(pool) {
  const totalWeight = pool.reduce((sum, e) => sum + (e.weight ?? 1), 0);
  let r = Math.random() * totalWeight;
  for (const entry of pool) {
    r -= entry.weight ?? 1;
    if (r <= 0) return entry;
  }
  return pool[pool.length - 1];
}
