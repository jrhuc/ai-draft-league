import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { Window } from 'happy-dom';

import { GuiServer } from '../src/gui/server.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-dom-'));
after(() => fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true }));

async function waitFor(predicate: () => boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('DOM condition was not reached before the test deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('built client boots to the live operator workspace', async () => {
  const gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  const base = await gui.listen(0);
  const window = new Window({ url: base });
  try {
    const shell = await (await fetch(base)).text();
    const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
    assert.ok(asset);
    const bundle = await (await fetch(new URL(asset, base))).text();
    window.document.body.innerHTML = '<div id="app"></div>';
    (window as unknown as Record<string, unknown>).EventSource = class {
      onmessage: unknown = null;
      close(): void {}
    };
    window.eval(bundle);
    await waitFor(() => window.document.querySelector('main h1') !== null);
    await waitFor(() => window.document.title === 'Live · VGC Model League');
    assert.equal(window.document.querySelectorAll('main h1').length, 1);
    assert.equal(window.document.querySelector('.primary-nav a[aria-current="page"]')?.textContent, 'Live');
    assert.ok(window.document.querySelector('nav[aria-label="Main navigation"] a[href="#tournaments"]'));
    assert.ok(window.document.querySelector('nav[aria-label="Main navigation"] a[href="#new-run"]'));
    assert.equal(window.document.querySelector('nav[aria-label="Main navigation"] a[href="#leagues"]'), null);
  } finally {
    await window.happyDOM.close();
    gui.close();
  }
});
