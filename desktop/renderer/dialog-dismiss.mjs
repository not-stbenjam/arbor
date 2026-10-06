// Use the browser's Escape path: requestClose fires a cancellable `cancel`
// before `close`, preserving each dialog's guards, cleanup and focus return.
export function installDialogDismiss(document) {
  for (const dialog of document.querySelectorAll('dialog')) {
    let pressedOutside = false, pointer;
    const outside = (event) => {
      const r = dialog.getBoundingClientRect();
      return event.target === dialog &&
        (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom);
    };
    dialog.addEventListener('pointerdown', (event) => {
      pressedOutside = event.button === 0 && outside(event);
      pointer = event.pointerId;
    });
    dialog.addEventListener('pointercancel', () => { pressedOutside = false; });
    dialog.addEventListener('close', () => { pressedOutside = false; });
    dialog.addEventListener('click', (event) => {
      // The second click of the gesture that opened a dialog can land on
      // its new backdrop. It is still the opening gesture, not dismissal.
      const dismiss = event.detail === 1 && pressedOutside && pointer === event.pointerId && outside(event);
      pressedOutside = false;
      if (dismiss && dialog.open) dialog.requestClose();
    });
  }
}
