// IDs identify registrations. A path only bridges a provisional ID when both
// snapshots contain exactly one row there; copied repositories may share paths.
export function reconcileSelection(
  previous,
  next,
  selection,
  sameWorkspace = true,
) {
  if (!sameWorkspace) return { ids: new Set(), cursor: "" };
  const existing = new Set(next.map((row) => row.id));
  const previousByID = new Map(previous.map((row) => [row.id, row]));
  const pathKey = (row) => JSON.stringify([row.host || "", row.path]);
  const oldPaths = new Map(),
    newPaths = new Map();
  for (const row of previous)
    oldPaths.set(pathKey(row), (oldPaths.get(pathKey(row)) || 0) + 1);
  for (const row of next) {
    const rows = newPaths.get(pathKey(row)) || [];
    rows.push(row);
    newPaths.set(pathKey(row), rows);
  }
  const remap = (id) => {
    if (existing.has(id)) return id;
    const old = previousByID.get(id),
      candidates = old && newPaths.get(pathKey(old));
    return old?.pending === true &&
      oldPaths.get(pathKey(old)) === 1 &&
      candidates?.length === 1
      ? candidates[0].id
      : "";
  };
  return {
    ids: new Set([...selection.ids].map(remap).filter(Boolean)),
    cursor: remap(selection.cursor),
  };
}

// Going to a row never unticks another. An arrow key or a right-click only
// moves the cursor there. A tick, which is a click on the row or its box, or
// Space, ticks or unticks that one row. A range ticks every row from the one
// the cursor was on to this one. Ranges only add, so one that carries on from
// another needs no memory of where the first began.
export function selectRow(
  selection,
  visible,
  id,
  { tick = false, range = false } = {},
) {
  const next = { ids: new Set(selection.ids), cursor: id };
  const index = (wanted) => visible.findIndex((row) => row.id === wanted);
  const from = range ? index(selection.cursor) : -1,
    to = index(id);
  if (from >= 0 && to >= 0)
    visible
      .slice(Math.min(from, to), Math.max(from, to) + 1)
      .forEach((row) => next.ids.add(row.id));
  else if (tick) next.ids.has(id) ? next.ids.delete(id) : next.ids.add(id);
  return next;
}
