export const readExcludes = (element) =>
  element.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

// The skip rules sit folded away, so their summary line says how many there
// are. Returns the update to call after setting the editor's value in code.
export function summarizeExcludes(editor, summary) {
  const update = () => {
    const count = readExcludes(editor).length;
    summary.textContent = count
      ? `${count} ${count === 1 ? "pattern" : "patterns"}`
      : "None";
  };
  editor.addEventListener("input", update);
  update();
  return update;
}
