import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import {
  ChangelogGenerator,
  escapeHTMLSequence,
  LINE_ADDED,
  type ChangelogDiffLine,
} from '../../../src/lib/changelog-generator.js';

/** Writes `files` (relative path → content) under `dir`. */
function writeTree(dir: string, files: Record<string, string | Buffer>): void {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

async function writeZip(file: string, files: Record<string, string>): Promise<void> {
  const zip = new JSZip();

  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }

  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
}

describe('escapeHTMLSequence', () => {
  it('escapes markup and non-ASCII characters as numeric entities', () => {
    expect(escapeHTMLSequence('<b>a & b</b> é')).toBe('&#60;b&#62;a &#38; b&#60;/b&#62; &#233;');
  });
});

describe('ChangelogGenerator', () => {
  let tmp: string;
  let oldDir: string;
  let newDir: string;
  let outDir: string;

  const changelog = (name = 'CHANGELOG.html') => fs.readFileSync(path.join(outDir, name), 'utf-8');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-dev-changelog-'));
    oldDir = path.join(tmp, 'old');
    newDir = path.join(tmp, 'new');
    outDir = path.join(tmp, 'out');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('options', () => {
    it('requires all three paths, and two different asset paths', () => {
      expect(
        () => new ChangelogGenerator({ oldAssetsPath: '', newAssetsPath: newDir, destinationPath: outDir }),
      ).toThrow('Previous assets path, current assets path and destination path are required');
      expect(
        () => new ChangelogGenerator({ oldAssetsPath: oldDir, newAssetsPath: oldDir, destinationPath: outDir }),
      ).toThrow('Previous and current assets paths must be different');
    });

    it('requires both asset paths to exist and hold files', () => {
      writeTree(newDir, { 'a.js': 'a' });

      expect(
        () => new ChangelogGenerator({ oldAssetsPath: oldDir, newAssetsPath: newDir, destinationPath: outDir }),
      ).toThrow(`Previous assets path ${oldDir} does not exist`);

      fs.mkdirSync(oldDir);

      expect(
        () => new ChangelogGenerator({ oldAssetsPath: oldDir, newAssetsPath: newDir, destinationPath: outDir }),
      ).toThrow(`Previous assets path ${oldDir} is empty`);
    });

    it('takes only a folder or a .zip file as assets', () => {
      writeTree(tmp, { 'old.tar': 'not a folder', 'new/a.js': 'a' });

      expect(
        () =>
          new ChangelogGenerator({
            oldAssetsPath: path.join(tmp, 'old.tar'),
            newAssetsPath: newDir,
            destinationPath: outDir,
          }),
      ).toThrow('It must be a folder or a zip file');
    });

    it('creates the destination folder', () => {
      writeTree(oldDir, { 'a.js': 'a' });
      writeTree(newDir, { 'a.js': 'b' });

      new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: path.join(outDir, 'deep'),
      });

      expect(fs.existsSync(path.join(outDir, 'deep'))).toBe(true);
    });
  });

  describe('generateChangelog', () => {
    it('lists added, removed and changed files, with the changed lines', async () => {
      writeTree(oldDir, { 'index.html': 'one\ntwo\nthree\n', 'gone.css': 'a {}', 'same.txt': 'same' });
      writeTree(newDir, { 'index.html': 'one\n2\nthree\n', 'new/app.js': 'x', 'same.txt': 'same' });

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
      }).generateChangelog();

      const html = changelog();

      expect(html).toContain('<span class="removed">Removed gone.css</span>');
      expect(html).toContain('<span class="added">Added new/app.js</span>');
      expect(html).toContain('<div class="diff-file-title">index.html</div>');
      expect(html).toMatch(/data-code-prefix="-">two</);
      expect(html).toMatch(/data-code-prefix="\+">2</);
      // An unchanged file isn't listed.
      expect(html).not.toContain('same.txt');
    });

    it('escapes the file content it shows', async () => {
      writeTree(oldDir, { 'index.html': '<p>old</p>\n' });
      writeTree(newDir, { 'index.html': '<script>alert(1)</script>\n' });

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
      }).generateChangelog();

      expect(changelog()).not.toContain('<script>alert(1)</script>');
      expect(changelog()).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
    });

    it('treats a build file whose hash changed as the same file', async () => {
      // A file next to assets/, or the comparison would start inside the only folder.
      writeTree(oldDir, { 'index.html': 'same', 'assets/app-1a2b3c4d.js': 'console.log(1);\n' });
      writeTree(newDir, { 'index.html': 'same', 'assets/app-9f8e7d6c.js': 'console.log(2);\n' });

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
      }).generateChangelog();

      const html = changelog();

      expect(html).toContain('<span class="from">assets/app-1a2b3c4d.js</span>');
      expect(html).toContain('<span class="to">assets/app-9f8e7d6c.js</span>');
      expect(html).not.toContain('Added');
      expect(html).not.toContain('Removed');
    });

    it('does not diff binary files', async () => {
      writeTree(oldDir, { 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]) });
      writeTree(newDir, { 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 4, 5, 6]) });

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
      }).generateChangelog();

      expect(changelog()).toContain('Binary file');
    });

    it('shows only the context lines around a change, and marks the lines it skips', async () => {
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
      const changed = [...lines];

      changed[14] = 'changed 15';
      writeTree(oldDir, { 'a.txt': `${lines.join('\n')}\n` });
      writeTree(newDir, { 'a.txt': `${changed.join('\n')}\n` });

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
        contextLines: 2,
      }).generateChangelog();

      const html = changelog();

      expect(html).toContain('>line 13<');
      expect(html).toContain('>line 17<');
      expect(html).not.toContain('>line 8<');
      expect(html).not.toContain('>line 22<');
      expect(html).toContain('<span class="blob-code-inner">Skip</span>');
    });

    it('compares .zip files, looking inside a single top folder', async () => {
      await writeZip(path.join(tmp, 'old.zip'), { 'build/index.html': 'old\n' });
      await writeZip(path.join(tmp, 'new.zip'), { 'build/index.html': 'new\n' });

      await new ChangelogGenerator({
        oldAssetsPath: path.join(tmp, 'old.zip'),
        newAssetsPath: path.join(tmp, 'new.zip'),
        destinationPath: outDir,
      }).generateChangelog();

      const html = changelog();

      expect(html).toContain('<div class="diff-file-title">index.html</div>');
      expect(html).toMatch(/data-code-prefix="\+">new</);
    });

    it('uses the given file name, template and line handlers', async () => {
      writeTree(oldDir, { 'a.txt': 'a\n' });
      writeTree(newDir, { 'a.txt': 'b\n' });

      const seen: ChangelogDiffLine[] = [];

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
        changelogFilename: 'changes.html',
        changelogTemplate: '<main>%FILES%</main>',
        diffFileTemplateHandler: (filename, htmlDiff) => `<section data-file="${filename}">${htmlDiff}</section>`,
        diffLineTemplateHandler: (line) => {
          seen.push(line);

          return `<i>${line.lineContent}</i>`;
        },
      }).generateChangelog();

      expect(changelog('changes.html')).toMatch(/^<main><section data-file="a\.txt">[\s\S]*<i>b<\/i>[\s\S]*<\/main>$/);
      expect(seen).toContainEqual({ lineNumber: 1, lineContent: 'b', lineType: LINE_ADDED });
    });

    it('falls back to the default template when the given one has no %FILES%', async () => {
      writeTree(oldDir, { 'a.txt': 'a\n' });
      writeTree(newDir, { 'a.txt': 'b\n' });

      await new ChangelogGenerator({
        oldAssetsPath: oldDir,
        newAssetsPath: newDir,
        destinationPath: outDir,
        changelogTemplate: '<main></main>',
      }).generateChangelog();

      expect(changelog()).toContain('<h1>Changelog Diff</h1>');
    });
  });
});
