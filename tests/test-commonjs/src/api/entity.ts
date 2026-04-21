import $ from 'jquery';
import { internalPageName } from '../constants';

export async function getEntities(): Promise<unknown> {
  const data = await $.ajax({
    url: `/data/page/${internalPageName}/entity`,
    method: 'GET',
    dataType: 'json',
    headers: { Accept: 'application/json' },
    xhrFields: { withCredentials: true },
    timeout: 25000,
  });

  return (data as { data?: unknown }).data;
}
