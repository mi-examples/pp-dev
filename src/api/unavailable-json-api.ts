/** Thrown when `/api/page/id/:id` returns non-JSON (e.g. HTML maintenance page). */
export const PAGE_DATA_FETCH_FRAGMENT = 'Something went wrong when fetching page data';

/** Thrown when `/api/page_template/...` returns non-JSON (e.g. HTML maintenance page). */
export const PAGE_TEMPLATE_FETCH_FRAGMENT = 'Something went wrong when fetching page template data';

const MAINTENANCE_SUFFIX = ' The instance may be down or in maintenance mode. Please try again later.';

export function unavailablePageDataError(): Error {
  return new Error(`${PAGE_DATA_FETCH_FRAGMENT}.${MAINTENANCE_SUFFIX}`);
}

export function unavailablePageTemplateDataError(): Error {
  return new Error(`${PAGE_TEMPLATE_FETCH_FRAGMENT}.${MAINTENANCE_SUFFIX}`);
}

/**
 * Plain `Error` from PageAPI / PageTemplateAPI when axios returns 200 + HTML or invalid JSON shape.
 */
export function isUnavailableJsonApiError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  return err.message.includes(PAGE_DATA_FETCH_FRAGMENT) || err.message.includes(PAGE_TEMPLATE_FETCH_FRAGMENT);
}
