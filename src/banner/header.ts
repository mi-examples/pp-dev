import type { RenderedChunk } from 'rolldown';

const START = '/*!\n';
const PREFIX = ' * ';
const END = '\n */';

const replacer = (substring: string, $1: string) => `${PREFIX}${$1}`;

export default function (_chunk: RenderedChunk) {
  const content = `***** DO NOT EDIT THIS CODE! *****
***** ------- *****`;

  return `${START}${content.replace(/^(.*)$/gm, replacer)}${END}`;
}
