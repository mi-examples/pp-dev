import $ from 'jquery';

export type AuthUser = { first_name?: string; last_name?: string };
import { internalPageName } from '../constants';

function ajaxAuthInfo(segment: string) {
  return $.ajax({
    url: `/data/page/${segment}/auth/info`,
    method: 'GET',
    dataType: 'json',
    headers: { Accept: 'application/json' },
    xhrFields: { withCredentials: true },
    timeout: 25000,
  });
}

export async function getCurrentUser(): Promise<AuthUser | undefined> {
  try {
    const data = await ajaxAuthInfo(internalPageName);

    return data.user;
  } catch (xhr: unknown) {
    const jq = xhr as JQuery.jqXHR;

    const msg = jq.statusText || 'request failed';
    
    throw new Error(
      `auth/info ${jq.status || '?'} (${internalPageName}): ${msg}`,
    );
  }
}
