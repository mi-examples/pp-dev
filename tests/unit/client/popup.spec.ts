// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPopupElement } from '../../../src/client/popup.js';

describe('createPopupElement', () => {
  it('renders popup title and content as text instead of executable HTML', () => {
    const unsafe = '<img src=x onerror=alert(1)>';
    const popup = createPopupElement({
      title: unsafe,
      content: `Sync failed:\n${unsafe}`,
      type: 'danger',
    });

    expect(popup.querySelector('.pp-dev-info__popup-title-text')?.textContent).toBe(unsafe);
    expect(popup.querySelector('.pp-dev-info__popup-content')?.textContent).toBe(`Sync failed:\n${unsafe}`);
    expect(popup.querySelector('img')).toBeNull();
    expect(popup.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(popup.querySelector('.pp-dev-info__popup-title-icon svg')).not.toBeNull();
  });

  it('renders the close control as a focusable, labeled button', () => {
    const popup = createPopupElement({ title: 'Title', content: 'Content' });
    const $close = popup.querySelector('.pp-dev-info__popup-title-close');

    expect($close?.tagName).toBe('BUTTON');
    expect($close?.getAttribute('type')).toBe('button');
    expect($close?.getAttribute('aria-label')).toBe('Close');
  });
});
