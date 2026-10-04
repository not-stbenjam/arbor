// Selection belongs to a tree view, not to backend revisions. Paths preserve
// identity as provisional rows receive their final Git worktree IDs.
export function reconcileSelection(
  previous,
  next,
  selection,
  sameWorkspace = true,
) {
  if (!sameWorkspace) return { ids: new Set(), anchor: "", cursor: "" };
  const selectedPaths = new Set(
    previous.filter((row) => selection.ids.has(row.id)).map((row) => row.path),
  );
  const existing = new Set(next.map((row) => row.id));
  const remap = (id) => {
    const old = previous.find((row) => row.id === id);
    return (
      next.find((row) => old && row.path === old.path)?.id ||
      (existing.has(id) ? id : "")
    );
  };
  return {
    ids: new Set(
      next
        .filter(
          (row) => selection.ids.has(row.id) || selectedPaths.has(row.path),
        )
        .map((row) => row.id),
    ),
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
