export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 320;
export function sidebarWidth(value) {
  return Number.isFinite(value) ? Math.round(Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, value))) : null;
}
export function sidebarLayout(width, hidden, viewport) {
  const maximum = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, viewport - 280));
  const fallback = viewport <= 800 ? 160 : viewport <= 1100 ? 185 : 208;
  return { maximum, width: hidden ? 0 : Math.min(maximum, sidebarWidth(width) ?? fallback) };
}
