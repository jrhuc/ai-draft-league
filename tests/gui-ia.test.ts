import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';

import { Window } from 'happy-dom';
import { GuiServer } from '../src/gui/server.js';

const RUNS_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-gui-ia-'));
let gui: GuiServer;
let base = '';
let bundle = '';

type TestElement = {
  textContent: string | null;
  getAttribute(name: string): string | null;
};

function element(node: unknown): TestElement {
  assert.ok(node);
  return node as TestElement;
}

before(async () => {
  gui = new GuiServer({ runsDir: RUNS_SCRATCH });
  base = await gui.listen(0);
  const shell = await (await fetch(base)).text();
  const asset = /src="(\.\/assets\/[^"]+\.js)"/.exec(shell)?.[1];
  assert.ok(asset);
  bundle = await (await fetch(new URL(asset, base))).text();
});

after(() => {
  gui.close();
  fs.rmSync(RUNS_SCRATCH, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, ms = 30000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('DOM condition was not reached before the test deadline');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function boot(hash = ''): Promise<Window> {
  const window = new Window({ url: `${base}${hash}` });
  window.document.body.innerHTML = '<div id="app"></div>';
  (window as unknown as Record<string, unknown>).EventSource = class {
    onmessage: unknown = null;
    close(): void {}
  };
  window.eval(bundle);
  await waitFor(() => window.document.querySelector('header.app-header') !== null);
  await waitFor(() => activeView(window).querySelector('h1') !== null);
  return window;
}

function activeView(window: Window) {
  const view = window.document.querySelector('main > .view.on:not([hidden])');
  assert.ok(view);
  return view;
}

function route(window: Window, hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new window.Event('hashchange'));
}

test('operator routes expose one H1 and one current navigation destination', async () => {
  const window = await boot();
  const routes = [
    ['', 'Live', 'Live'],
    ['#live', 'Live', 'Live'],
    ['#tournaments', 'Tournaments', 'Tournaments'],
    ['#new-run', 'New run', 'New run'],
  ] as const;
  try {
    for (const [hash, label, title] of routes) {
      route(window, hash);
      await waitFor(() => window.document.title === `${title} · VGC Model League`);
      await waitFor(() => activeView(window).querySelector('h1') !== null);
      assert.equal(activeView(window).querySelectorAll('h1').length, 1);
      assert.equal(window.document.querySelectorAll('.primary-nav a[aria-current="page"]').length, 1);
      assert.equal(window.document.querySelector('.primary-nav a[aria-current="page"]')?.textContent, label);
    }
  } finally {
    await window.happyDOM.close();
  }
});

test('navigation publishes only operator destinations', async () => {
  const window = await boot();
  try {
    const links = [...window.document.querySelectorAll('.primary-nav a')].map((node) => element(node));
    const destinations = new Map(links.map((link) => [link.textContent, link.getAttribute('href')]));
    assert.deepEqual(
      [...destinations],
      [
        ['Live', '#live'],
        ['Tournaments', '#tournaments'],
        ['New run', '#new-run'],
      ],
    );
  } finally {
    await window.happyDOM.close();
  }
});
