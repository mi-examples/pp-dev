import { DateTime } from 'luxon';
import $ from 'jquery';
import { html } from '@metricinsights/pp-dev/helpers';
import { getCurrentUser } from './api/user';
import { getDatasetData } from './api/dataset-data';
import { getEntities } from './api/entity';

console.log('Changed ts file');
console.log('New test message');
console.log(DateTime.now().toFormat('yyyy dd MMMM'));

const htmlPart = html`<div class="helpers-demo">
  <header class="helpers-demo__header">Header</header>
  <div class="helpers-demo__body">Body — main content area</div>
  <footer class="helpers-demo__footer">Footer</footer>
</div>`;

function setUserLine(text: string, loading: boolean): void {
  const $user = $('#current-user');

  $user.text(text);
  $user.toggleClass('app__user--loading', loading);
}

$(() => {
  $('#public-env').text(
    `VITE_PUBLIC_TEST: ${import.meta.env.VITE_PUBLIC_TEST ?? 'No test variable'}`,
  );

  $('#helpers-html-root').append(htmlPart);

  setUserLine('Current user: loading…', true);

  void getCurrentUser()
    .then((user) => {
      const name = [user?.first_name, user?.last_name]
        .filter(Boolean)
        .join(' ')
        .trim();

      setUserLine(
        name ? `Current user: ${name}` : 'Current user: (signed out or empty)',
        false,
      );
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);

      setUserLine(`Current user: could not load — ${detail}`, false);
    });

  void getDatasetData(1).catch(() => {
    /* optional proxy warm-up */
  });

  void getEntities().catch(() => {
    /* optional proxy warm-up */
  });
});

export default {
  test: 1,
};
