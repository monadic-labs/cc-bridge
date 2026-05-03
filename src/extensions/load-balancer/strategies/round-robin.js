export function selectRoundRobin(pool, state) {
  const idx = state.counter % pool.length;
  state.counter++;
  return pool[idx];
}
