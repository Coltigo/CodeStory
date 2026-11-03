import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {installDialogMotion} from '../src/dialogs.js';

function fixture() {
  const dom = new JSDOM('<button id="open">Connect AI</button><button id="other">Other action</button><dialog><h2>AI connections</h2><form method="dialog"><button id="close">Close</button></form></dialog>', {pretendToBeVisual:true});
  const {document} = dom.window;
  const dialog = document.querySelector('dialog');
  const cleanup = installDialogMotion(document);
  const opener = document.getElementById('open');
  function open() { opener.focus(); dialog.open = true; document.getElementById('close').focus(); }
  function close() { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); }
  return {dom,document,dialog,opener,open,close,cleanup};
}

test('dialog enhancement names a dialog with its own heading', () => {
  const ui = fixture();
  try {
    const heading = ui.document.querySelector('h2');
    assert.ok(heading.id);
    assert.equal(ui.dialog.getAttribute('aria-labelledby'),heading.id);
    assert.equal(ui.document.querySelector('form').getAttribute('method'),'dialog');
  } finally { ui.cleanup(); ui.dom.window.close(); }
});

test('closing a dialog restores its opener when focus stayed inside', () => {
  const ui = fixture();
  try { ui.open(); ui.close(); assert.equal(ui.document.activeElement,ui.opener); }
  finally { ui.cleanup(); ui.dom.window.close(); }
});

test('native or application focus restoration is not overridden', () => {
  const ui = fixture();
  try {
    ui.open();
    const other = ui.document.getElementById('other'); other.focus();
    ui.close(); assert.equal(ui.document.activeElement,other);
  } finally { ui.cleanup(); ui.dom.window.close(); }
});

test('Escape cancellation stays native and existing accessible names stay intact', async () => {
  const ui = fixture();
  try {
    ui.open();
    const cancel = new ui.dom.window.Event('cancel',{cancelable:true});
    assert.equal(ui.dialog.dispatchEvent(cancel),true);
    assert.equal(cancel.defaultPrevented,false);
    const named = ui.document.createElement('dialog');named.setAttribute('aria-label','Provider details');
    named.innerHTML='<h2>Another heading</h2>';ui.document.body.append(named);
    await Promise.resolve();
    assert.equal(named.getAttribute('aria-label'),'Provider details');
    assert.equal(named.hasAttribute('aria-labelledby'),false);
  } finally { ui.cleanup(); ui.dom.window.close(); }
});
