import { describe, it, expect } from 'vitest';
import { templateFunction, html, css } from '../../../src/helpers/formatting.js';

describe('Formatting Helpers', () => {
  describe('templateFunction', () => {
    it('should return the string content from template literal', () => {
      const result = templateFunction`Hello World`;
      expect(result).toBe('Hello World');
    });

    it('should handle template literals with values', () => {
      const name = 'Test';
      const result = templateFunction`Hello ${name}!`;
      expect(result).toBe('Hello Test!');
    });

    it('should handle multiple values', () => {
      const a = 1;
      const b = 2;
      const result = templateFunction`Sum of ${a} and ${b} is ${a + b}`;
      expect(result).toBe('Sum of 1 and 2 is 3');
    });

    it('should preserve whitespace', () => {
      const result = templateFunction`  spaces  `;
      expect(result).toBe('  spaces  ');
    });

    it('should handle empty template', () => {
      const result = templateFunction``;
      expect(result).toBe('');
    });

    it('should handle newlines', () => {
      const result = templateFunction`line1
line2`;
      expect(result).toContain('line1');
      expect(result).toContain('line2');
    });
  });

  describe('html', () => {
    it('should be an alias for templateFunction', () => {
      expect(html).toBe(templateFunction);
    });

    it('should work with HTML content', () => {
      const className = 'container';
      const result = html`<div class="${className}">Content</div>`;
      expect(result).toBe('<div class="container">Content</div>');
    });

    it('should handle complex HTML structures', () => {
      const items = ['a', 'b', 'c'];
      const result = html`
        <ul>
          ${items.map((item) => `<li>${item}</li>`).join('')}
        </ul>
      `;
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>a</li>');
      expect(result).toContain('<li>b</li>');
      expect(result).toContain('<li>c</li>');
      expect(result).toContain('</ul>');
    });
  });

  describe('css', () => {
    it('should be an alias for templateFunction', () => {
      expect(css).toBe(templateFunction);
    });

    it('should work with CSS content', () => {
      const color = 'red';
      const result = css`.container { color: ${color}; }`;
      expect(result).toBe('.container { color: red; }');
    });

    it('should handle complex CSS structures', () => {
      const primaryColor = '#007bff';
      const fontSize = '16px';
      const result = css`
        .button {
          background-color: ${primaryColor};
          font-size: ${fontSize};
          padding: 8px 16px;
        }
      `;
      expect(result).toContain(`background-color: ${primaryColor}`);
      expect(result).toContain(`font-size: ${fontSize}`);
    });
  });
});
