// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { tokenLoginFunction } from '../../../src/lib/helpers/login.helper.js';

/**
 * The token login form added to MI's login page. It read the MI host from a global `const host` the
 * injected script declared, which threw on any MI page whose own scripts declare `host`, and put it
 * into the page as HTML.
 */

// MI's login form: a wrapper of rows, whose last row the helper copies for its own.
const LOGIN_PAGE =
  '<div id="mi-react-root"><form><div>' +
  '<div><input name="login"></div><div><input name="password"></div><div><button>Log in</button></div>' +
  '</div></form></div>';

/** Runs the form's code the way the proxy injects it, as a script of the page. */
function inject(host: string) {
  window.eval(`(${tokenLoginFunction.toString()})(${JSON.stringify(host)})`);
}

describe('tokenLoginFunction', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('runs on a page whose own scripts declare `host`', () => {
    document.body.innerHTML = LOGIN_PAGE;
    window.eval('var host = "the page\'s own";');

    expect(() => inject('mi.example.com')).not.toThrow();
    expect(document.querySelector('.helper-login-wrapper')).not.toBeNull();
    expect((window as unknown as { host: string }).host).toBe("the page's own");
  });

  it('links to the token page of the MI host it was given', () => {
    document.body.innerHTML = LOGIN_PAGE;
    inject('mi.example.com');

    const caption = document.getElementById('token-caption')!;

    expect(caption.textContent).toBe('You can get the API Token here');
    expect(caption.querySelector('a')!.getAttribute('href')).toBe('https://mi.example.com/api-token');
  });

  it('puts the host into the page as text, not as HTML', () => {
    document.body.innerHTML = LOGIN_PAGE;
    inject('mi.example.com"><img src=x onerror=alert(1)>');

    expect(document.querySelector('#token-caption img')).toBeNull();
  });
});
