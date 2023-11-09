import { DateTime } from 'luxon';
import { css, html } from '@metricinsights/pp-dev/helpers';
console.log('Changed ts file');

console.log('New test message');

console.log(DateTime.now().toFormat('yyyy dd MMMM'));

const htmlPart = html`<div class="html-part">
  <div>Header</div>
  <div>Body</div>
  <div>Footer</div>
</div>`;

const cssPart = css`
  .html-part {
    display: flex;
    flex-direction: column;
  }
`;

const scssPart = css`
  .html-part {
    display: flex;
    flex-direction: column;

    > div {
      padding: 10px;
    }
  }
`;

export default {
  test: 1,
};
