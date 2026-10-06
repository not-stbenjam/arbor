import { icon } from './presentation.mjs';
import { SIDEBAR_MIN, sidebarWidth, sidebarLayout } from '../common/sidebar-layout.mjs';

export function createSidebarController({ document, api, notify, window = document.defaultView }) {
  const sidebar = document.querySelector('#workspace-sidebar');
  const edge = document.querySelector('#sidebar-resizer');
  const button = document.querySelector('#sidebar-toggle');
  let width = null, hidden = false, drag = null;
  const layout = () => sidebarLayout(width, hidden, window.innerWidth);
  function render() {
    const current = layout();
    document.body.style.setProperty('--sidebar-width', `${current.width}px`);
    sidebar.hidden = hidden;
    edge.hidden = hidden;
    edge.setAttribute('aria-valuemin', SIDEBAR_MIN);
    edge.setAttribute('aria-valuemax', current.maximum);
    edge.setAttribute('aria-valuenow', current.width);
    edge.setAttribute('aria-valuetext', `${current.width} pixels`);
    button.innerHTML = icon(hidden ? 'panel-left-open' : 'panel-left-close');
    button.setAttribute('aria-expanded', String(!hidden));
    button.setAttribute('aria-label', hidden ? 'Show sidebar' : 'Hide sidebar');
    button.title = `${hidden ? 'Show' : 'Hide'} sidebar (${api.platform === 'darwin' ? '⌘' : 'Ctrl+'}B)`;
  }
  function save() {
    api.saveView({ sidebarWidth: width, sidebarHidden: hidden }).catch(error => notify(`Could not save view: ${error.message}`, true));
  }
  function toggle() {
    hidden = !hidden;
    if (hidden) {
      sidebar.querySelector?.('[popover]:popover-open')?.hidePopover();
      if (sidebar.contains(document.activeElement)) button.focus();
    }
    render(); save();
  }
  button.onclick = toggle;
  edge.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, width: layout().width, original: width };
    edge.setPointerCapture(event.pointerId);
    edge.focus();
    event.preventDefault();
  });
  edge.addEventListener('pointermove', (event) => {
    if (!drag) return;
    width = Math.max(SIDEBAR_MIN, Math.min(layout().maximum, drag.width + event.clientX - drag.x));
    width = Math.round(width); render();
  });
  edge.addEventListener('pointerup', () => { if (drag) { drag = null; save(); } });
  edge.addEventListener('pointercancel', () => { if (drag) { width = drag.original; drag = null; render(); } });
  edge.addEventListener('dblclick', () => { width = null; render(); save(); });
  edge.addEventListener('keydown', (event) => {
    let next;
    const current = layout();
    if (event.key === 'ArrowLeft') next = current.width - (event.shiftKey ? 32 : 8);
    if (event.key === 'ArrowRight') next = current.width + (event.shiftKey ? 32 : 8);
    if (event.key === 'Home') next = SIDEBAR_MIN;
    if (event.key === 'End') next = current.maximum;
    if (next === undefined) return;
    event.preventDefault();
    width = Math.max(SIDEBAR_MIN, Math.min(current.maximum, next));
    render(); save();
  });
  window.addEventListener('resize', render);
  render();
  return { toggle, restore(saved) { width = sidebarWidth(saved.sidebarWidth); hidden = saved.sidebarHidden === true; render(); },
    dispose() { window.removeEventListener('resize', render); } };
}
