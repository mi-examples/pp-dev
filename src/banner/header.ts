import { RenderedChunk } from 'rollup';

const START = '/*!\n';
const PREFIX = ' * ';
const END = '\n */';

const replacer = (substring: string, $1: string) => `${PREFIX}${$1}`;

export default function (chunk: RenderedChunk) {
  const content = `***** DO NOT EDIT THIS CODE! *****
***** ------- *****`;

  return `${START}${content.replace(/^(.*)$/gm, replacer)}${END}`;
}
