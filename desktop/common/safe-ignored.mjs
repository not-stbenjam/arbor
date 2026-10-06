// Match Go filepath.Match's syntax validation, including escaped class members.
function wellFormed(pattern) {
  const letters = Array.from(pattern);
  for (let i = 0; i < letters.length; i++) {
    if (letters[i] === "\\") {
      if (++i >= letters.length) return false;
    } else if (letters[i] === "[") {
      i++;
      if (letters[i] === "^") i++;
      let members = 0;
      const member = () => {
        if (i >= letters.length || letters[i] === "-" || letters[i] === "]")
          return false;
        if (letters[i] === "\\" && ++i >= letters.length) return false;
        i++;
        return true;
      };
      while (!(letters[i] === "]" && members)) {
        if (!member()) return false;
        if (letters[i] === "-") {
          i++;
          if (!member()) return false;
        }
        members++;
      }
    }
  }
  return true;
}

export function validSafeIgnoredRule(rule) {
  if (
    typeof rule !== "string" || !rule.trim() || rule.length > 4096 ||
    rule.includes("\0") || rule.startsWith("/") || rule.startsWith("~/")
  ) return false;
  const pattern = rule.replace(/^\.\//, "").replace(/\/$/, "");
  return pattern.split("/").every((part) =>
    part && part !== "." && part !== ".." && wellFormed(part));
}

export const safeIgnoredLabel = "Ignored files marked safe";
export const safeIgnoredSummary = (row) => {
  const rules = row.matchedSafeIgnored || [];
  const names = rules.slice(0, 4).join(", ");
  return `${safeIgnoredLabel}${names ? `: ${names}` : ""}${rules.length > 4 ? ` (+${rules.length - 4} more)` : ""}`;
};
export const safeIgnoredDetail = (row) => row.allIgnoredSafe
  ? `${safeIgnoredSummary(row)}. Deleted permanently; Undo cannot restore them.` : "";
