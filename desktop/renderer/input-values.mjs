export const readExcludes = (element) =>
  element.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
