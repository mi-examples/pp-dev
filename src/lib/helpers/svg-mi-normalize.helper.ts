import { readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { JSDOM } from 'jsdom';

/**
 * MI re-serializes every uploaded SVG server-side on ingest — confirmed empirically (PP-4123)
 * against a real MI instance: it adds a UTF-8 XML declaration, strips XML comments, expands
 * self-closing tags into explicit open/close pairs (even for genuinely empty elements), hoists
 * `xmlns`/`xmlns:*` to the front of the root `<svg>` element's attributes (leaving every other
 * attribute's relative order untouched, on the root and on descendants), and pretty-prints with
 * 2-space indentation. Since MI discards whatever byte-level formatting/minification pp-dev
 * produced, VERSION.json's hash (computed from the local build) never matches what MI actually
 * stores — a persistent "confirm in UI" mismatch on every sync, regardless of source content.
 *
 * This reproduces that exact transform locally so the build's own hash matches what MI will
 * store, rather than being invalidated by it. Validated byte-for-byte against 3 real MI round
 * trips (two reported icons plus a synthetic probe with comments/self-closing/reordered attrs).
 *
 * Returns the input unchanged if it doesn't parse as a single root `<svg>` element.
 */
export function normalizeSvgLikeMi(svgText: string): string {
  const dom = new JSDOM(`<!doctype html><html><body>${svgText}</body></html>`);
  const document = dom.window.document;
  const svg = document.querySelector('svg');

  if (!svg) {
    return svgText;
  }

  removeComments(svg);
  reorderNamespaceAttributesFirst(svg);
  reindent(svg, 0, document);

  return `<?xml version="1.0" encoding="UTF-8"?>\n${svg.outerHTML}\n`;
}

/** Normalizes every `.svg` file found under `dir` in place, overwriting changed files only. */
export function normalizeSvgFilesInDir(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      normalizeSvgFilesInDir(fullPath);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.svg')) {
      const original = readFileSync(fullPath, 'utf-8');
      const normalized = normalizeSvgLikeMi(original);

      if (normalized !== original) {
        writeFileSync(fullPath, normalized, 'utf-8');
      }
    }
  }
}

function removeComments(node: Element): void {
  const comments = Array.from(node.childNodes).filter((child) => child.nodeType === 8);

  comments.forEach((comment) => node.removeChild(comment));

  Array.from(node.children).forEach((child) => removeComments(child));
}

/** Only the root `<svg>`'s own attributes — MI doesn't reorder attributes on descendants. */
function reorderNamespaceAttributesFirst(svg: Element): void {
  const attributes = Array.from(svg.attributes);
  const isNamespaceDeclaration = (name: string) => name === 'xmlns' || name.startsWith('xmlns:');
  const ordered = [
    ...attributes.filter((attr) => isNamespaceDeclaration(attr.name)),
    ...attributes.filter((attr) => !isNamespaceDeclaration(attr.name)),
  ];

  attributes.forEach((attr) => svg.removeAttribute(attr.name));
  ordered.forEach((attr) => svg.setAttribute(attr.name, attr.value));
}

/**
 * Rebuilds `el`'s whitespace as 2-space-per-depth indentation between element children, matching
 * MI's pretty-printer. Elements that mix element children with actual text content (e.g. `<text>`,
 * `<tspan>`) are left untouched — indentation there would alter what gets rendered.
 */
function reindent(el: Element, depth: number, document: Document): void {
  const children = Array.from(el.childNodes);
  const hasSignificantText = children.some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');

  if (hasSignificantText) {
    return;
  }

  const elementChildren = children.filter((node): node is Element => node.nodeType === 1);

  if (elementChildren.length === 0) {
    return;
  }

  children.forEach((node) => el.removeChild(node));

  const innerIndent = `\n${'  '.repeat(depth + 1)}`;
  const outerIndent = `\n${'  '.repeat(depth)}`;

  elementChildren.forEach((child) => {
    el.appendChild(document.createTextNode(innerIndent));
    el.appendChild(child);
    reindent(child, depth + 1, document);
  });

  el.appendChild(document.createTextNode(outerIndent));
}
