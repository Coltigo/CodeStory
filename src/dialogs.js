/** Keep native dialog behavior and add a small accessibility fallback.
 * Motion is CSS-only: showModal(), close(), Escape and dialog forms stay native.
 */
export function installDialogMotion(document) {
  const window = document.defaultView;
  if (!window) return () => {};
  const openers = new WeakMap();
  const cleanups = [];
  let lastOutsideFocus = document.activeElement;
  let headingNumber = 0;

  function prepare(dialog) {
    if (!dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby')) {
      const heading = dialog.querySelector('h1,h2,h3');
      if (heading) {
        if (!heading.id) {
          do { headingNumber++; } while (document.getElementById('dialog-heading-' + headingNumber));
          heading.id = 'dialog-heading-' + headingNumber;
        }
        dialog.setAttribute('aria-labelledby', heading.id);
      }
    }
    const onClose = () => {
      const opener = openers.get(dialog);
      openers.delete(dialog);
      const active = document.activeElement;
      // Native dialogs already restore focus in supporting browsers. Only fill
      // in when focus remained in the closed dialog or fell back to the body.
      if (opener?.isConnected && !opener.disabled &&
          (!active || active === document.body || dialog.contains(active))) {
        opener.focus({preventScroll:true});
      }
    };
    dialog.addEventListener('close', onClose);
    cleanups.push(() => dialog.removeEventListener('close', onClose));
  }

  const dialogs = new WeakSet();
  function prepareAll() {
    for (const dialog of document.querySelectorAll('dialog')) {
      if (!dialogs.has(dialog)) { dialogs.add(dialog); prepare(dialog); }
    }
  }
  const onFocus = event => {
    const dialog = event.target.closest?.('dialog[open]');
    if (dialog) {
      if (!openers.has(dialog) && lastOutsideFocus && !dialog.contains(lastOutsideFocus)) {
        openers.set(dialog, lastOutsideFocus);
      }
    } else {
      lastOutsideFocus = event.target;
    }
  };
  prepareAll();
  document.addEventListener('focusin', onFocus);
  const observer = new window.MutationObserver(prepareAll);
  observer.observe(document.body || document.documentElement, {childList:true,subtree:true});
  return () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocus);
    cleanups.forEach(cleanup => cleanup());
  };
}
