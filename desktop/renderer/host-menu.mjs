import { esc, icon } from './presentation.mjs';

export function createHostMenu({ document, choices, selected, choose, manage }) {
  const button = document.querySelector('#machine-button');
  const menu = document.querySelector('#host-menu');
  let entries = [], openOnPress = false;
  const items = () => [...menu.querySelectorAll('[role^="menuitem"]')];
  const close = () => { menu.hidePopover(); button.setAttribute('aria-expanded', 'false'); };
  function open(last = false) {
    if (button.disabled) return;
    entries = choices();
    menu.innerHTML = entries.map((entry, index) =>
      `<button class="machine-option" ${entry.host === null ? "data-all-hosts" : `data-host="${esc(entry.host)}"`} role="menuitemradio" aria-checked="${entry.host === selected()}" tabindex="-1" data-choice="${index}"><span>${esc(entry.name || entry.host)}</span>${entry.host === selected() ? icon('check') : ''}</button>`,
    ).join('') + '<button role="menuitem" tabindex="-1" data-manage>Manage hosts…</button>';
    const rect = button.getBoundingClientRect();
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.minWidth = `${rect.width}px`;
    menu.showPopover();
    button.setAttribute('aria-expanded', 'true');
    (last ? items().at(-1) : menu.querySelector('[aria-checked="true"]') || items()[0]).focus();
  }
  // Native light-dismiss runs before click. Remember whether this press
  // began on the open dropdown, so its button does not immediately reopen it.
  button.addEventListener('pointerdown', () => { openOnPress = menu.matches(':popover-open'); });
  button.onclick = (event) => (event?.detail > 0 ? openOnPress : menu.matches(':popover-open')) ? close() : open();
  button.addEventListener('keydown', (event) => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); open(event.key === 'ArrowUp'); }
  });
  menu.addEventListener('toggle', () => button.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('button');
    if (!item) return;
    close(); button.focus();
    if (item.hasAttribute('data-manage')) manage();
    else choose(entries[Number(item.dataset.choice)].host);
  });
  menu.addEventListener('keydown', (event) => {
    const list = items(), index = list.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % list.length;
    if (event.key === 'ArrowUp') next = (index - 1 + list.length) % list.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = list.length - 1;
    if (next !== undefined) { event.preventDefault(); list[next].focus(); }
    if (event.key === 'Escape') { event.preventDefault(); close(); button.focus(); }
    if (event.key === 'Tab') close();
  });
  return { open, close };
}
