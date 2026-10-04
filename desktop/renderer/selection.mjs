// IDs identify registrations. A path only bridges a provisional ID when both
// snapshots contain exactly one row there; copied repositories may share paths.
export function reconcileSelection(
  previous,
  next,
  selection,
  sameWorkspace = true,
) {
  if (!sameWorkspace) return { ids: new Set(), anchor: "", cursor: "" };
  const existing = new Set(next.map((row) => row.id));
  const previousByID = new Map(previous.map((row) => [row.id, row]));
  const oldPaths = new Map(),
    newPaths = new Map();
  for (const row of previous)
    oldPaths.set(row.path, (oldPaths.get(row.path) || 0) + 1);
  for (const row of next) {
    const rows = newPaths.get(row.path) || [];
    rows.push(row);
    newPaths.set(row.path, rows);
  }
  const remap = (id) => {
    if (existing.has(id)) return id;
    const old = previousByID.get(id),
      candidates = old && newPaths.get(old.path);
    return old?.pending === true &&
      oldPaths.get(old.path) === 1 &&
      candidates?.length === 1
      ? candidates[0].id
      : "";
  };
  return {
    ids: new Set([...selection.ids].map(remap).filter(Boolean)),
    anchor: remap(selection.anchor),
    cursor: remap(selection.cursor),
  };
}

export function selectRow(selection, visible, id, modifiers = {}) {
  const next = {
    ids: new Set(selection.ids),
    anchor: selection.anchor,
    cursor: id,
  };
  if (modifiers.shiftKey && next.anchor) {
    const a = visible.findIndex((row) => row.id === next.anchor),
      b = visible.findIndex((row) => row.id === id);
    if (a >= 0 && b >= 0) {
      if (!modifiers.metaKey && !modifiers.ctrlKey) next.ids.clear();
      visible
        .slice(Math.min(a, b), Math.max(a, b) + 1)
        .forEach((row) => next.ids.add(row.id));
    }
  } else if (modifiers.metaKey || modifiers.ctrlKey) {
    next.ids.has(id) ? next.ids.delete(id) : next.ids.add(id);
    next.anchor = id;
  } else {
    next.ids = new Set([id]);
    next.anchor = id;
  }
  return next;
}
