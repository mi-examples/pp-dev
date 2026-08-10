export interface InfoPopupOptions {
  title: string;
  content: string;
  style?: string;
  className?: string;
  duration?: number;
  onClose?: () => void;
  type?: 'success' | 'danger' | 'info' | 'warning';
}

const ICON_SIZE = 16;
const CLOSE_ICON_SIZE = 12;

const TYPE_ICONS: Record<NonNullable<InfoPopupOptions['type']>, string> = {
  success: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
  danger: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/></svg>`,
  warning: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  info: `<svg viewBox="0 0 24 24" width="${ICON_SIZE}" height="${ICON_SIZE}" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
};

export function createPopupElement(opts: InfoPopupOptions): HTMLDivElement {
  const $popup = document.createElement('div');

  $popup.classList.add('pp-dev-info-namespace');

  const $popupContent = document.createElement('div');

  $popupContent.classList.add('pp-dev-info__popup');

  if (opts.type) {
    $popupContent.classList.add(`pp-dev-info__popup--${opts.type}`);
  }

  if (opts.className) {
    $popupContent.classList.add(...opts.className.split(/\s+/).filter(Boolean));
  }

  if (opts.style) {
    $popupContent.style.cssText = opts.style;
  }

  const $title = document.createElement('div');

  $title.classList.add('pp-dev-info__popup-title');

  if (opts.type) {
    const $icon = document.createElement('div');

    $icon.classList.add('pp-dev-info__popup-title-icon');
    $icon.innerHTML = TYPE_ICONS[opts.type];
    $title.appendChild($icon);
  }

  const $titleText = document.createElement('div');

  $titleText.classList.add('pp-dev-info__popup-title-text');
  $titleText.textContent = opts.title;

  const $close = document.createElement('button');

  $close.type = 'button';
  $close.setAttribute('aria-label', 'Close');
  $close.classList.add('pp-dev-info__popup-title-close');
  $close.innerHTML = `
    <svg
      viewBox="0 0 24 24"
      width="${CLOSE_ICON_SIZE}"
      height="${CLOSE_ICON_SIZE}"
      stroke="currentColor"
      stroke-width="1.5"
      fill="none"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M18 6L6 18"></path>
      <path d="M6 6l12 12"></path>
    </svg>
  `;

  const $content = document.createElement('div');

  $content.classList.add('pp-dev-info__popup-content');
  $content.textContent = opts.content;

  $title.append($titleText, $close);
  $popupContent.append($title, $content);
  $popup.appendChild($popupContent);

  return $popup;
}
