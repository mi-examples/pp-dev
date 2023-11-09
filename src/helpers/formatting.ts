/**
 * Prefix function for JS template literals to enable syntax highlighting in IDEs
 * @param strings
 * @param values
 * @example
 * import { templateFunction as sql } from '@metricinsights/pp-dev/helpers';
 *
 * const query = sql`SELECT * FROM table WHERE id = 1`;
 */
export const templateFunction = (strings: TemplateStringsArray, ...values: any[]): string =>
  String.raw({ raw: strings }, ...values);

/**
 * Prefix function for JS template literals to enable syntax highlighting for HTML in IDEs
 * @param strings
 * @param values
 */
export const html = templateFunction;

/**
 * Prefix function for JS template literals to enable syntax highlighting for CSS and SCSS in IDEs
 * @param strings
 * @param values
 */
export const css = templateFunction;
