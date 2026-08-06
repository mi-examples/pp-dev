// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { createPanelStateController } from '../../../src/client/panel-state.js';
import { initPanelSettings } from '../../../src/client/panel-settings.js';

function makePanel(templateLess: string): HTMLElement {
  const $panel = document.createElement('div');

  $panel.className = 'pp-dev-info-namespace pp-dev-info';
  $panel.dataset.position = 'bottom-right';
  $panel.dataset.autoHide = 'false';
  $panel.dataset.hidden = 'false';
  $panel.dataset.templateLess = templateLess;

  const $settingsBtn = document.createElement('button');

  $settingsBtn.className = 'pp-dev-info__settings-btn';
  $panel.appendChild($settingsBtn);

  document.body.appendChild($panel);

  return $panel;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('initPanelSettings — "Reload variables" button visibility', () => {
  it('renders the button when the page is not templateLess', () => {
    const $panel = makePanel('false');
    const controller = createPanelStateController($panel);

    initPanelSettings($panel, controller);
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();

    expect($panel.querySelector('.pp-dev-info__reload-vars-btn')).not.toBeNull();
  });

  it('omits the button entirely when the page is templateLess', () => {
    const $panel = makePanel('true');
    const controller = createPanelStateController($panel);

    initPanelSettings($panel, controller);
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();

    expect($panel.querySelector('.pp-dev-info__reload-vars-btn')).toBeNull();
  });

  it('invokes onReloadVariablesClick and closes the popover when clicked', () => {
    const $panel = makePanel('false');
    const controller = createPanelStateController($panel);
    let clicked = false;

    initPanelSettings($panel, controller, { onReloadVariablesClick: () => (clicked = true) });
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__reload-vars-btn')!.click();

    expect(clicked).toBe(true);
    expect($panel.querySelector('.pp-dev-info__settings')).toBeNull();
  });
});

describe('initPanelSettings — "Open variables editor" button visibility', () => {
  it('renders the button when the page is not templateLess', () => {
    const $panel = makePanel('false');
    const controller = createPanelStateController($panel);

    initPanelSettings($panel, controller);
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();

    expect($panel.querySelector('.pp-dev-info__open-editor-btn')).not.toBeNull();
  });

  it('omits the button entirely when the page is templateLess', () => {
    const $panel = makePanel('true');
    const controller = createPanelStateController($panel);

    initPanelSettings($panel, controller);
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();

    expect($panel.querySelector('.pp-dev-info__open-editor-btn')).toBeNull();
  });

  it('invokes onOpenVariablesEditorClick and closes the popover when clicked', () => {
    const $panel = makePanel('false');
    const controller = createPanelStateController($panel);
    let clicked = false;

    initPanelSettings($panel, controller, { onOpenVariablesEditorClick: () => (clicked = true) });
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__open-editor-btn')!.click();

    expect(clicked).toBe(true);
    expect($panel.querySelector('.pp-dev-info__settings')).toBeNull();
  });
});

describe('initPanelSettings — "Open request inspector" button (always present)', () => {
  it('renders regardless of templateLess', () => {
    for (const templateLess of ['true', 'false']) {
      const $panel = makePanel(templateLess);
      const controller = createPanelStateController($panel);

      initPanelSettings($panel, controller);
      $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();

      expect($panel.querySelector('.pp-dev-info__open-inspector-btn')).not.toBeNull();
    }
  });

  it('invokes onOpenInspectorClick and closes the popover when clicked', () => {
    const $panel = makePanel('true');
    const controller = createPanelStateController($panel);
    let clicked = false;

    initPanelSettings($panel, controller, { onOpenInspectorClick: () => (clicked = true) });
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__settings-btn')!.click();
    $panel.querySelector<HTMLButtonElement>('.pp-dev-info__open-inspector-btn')!.click();

    expect(clicked).toBe(true);
    expect($panel.querySelector('.pp-dev-info__settings')).toBeNull();
  });
});
