import JSZip from 'jszip';

/** A ZIP of `files` (path → content), as a sync backup or a build archive looks in the specs. */
export async function zipFromEntries(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();

  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }

  return zip.generateAsync({ type: 'nodebuffer' });
}
