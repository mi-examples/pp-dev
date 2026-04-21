import { getInternalPageName } from '../constants';

export async function getEntities(): Promise<unknown> {
  const internalPageName = getInternalPageName();

  const res = await fetch(`/data/page/${internalPageName}/entity`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });

  const body = await res.json();

  return (body as { data?: unknown }).data;
}
