export function getInternalPageName(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.location.pathname.replace(/\/p[tl]?\/([^/]+)\/?.*/, '$1');
}
