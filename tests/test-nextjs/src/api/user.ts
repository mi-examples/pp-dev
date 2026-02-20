/**
 * Fetches the current authenticated user's information from the server.
 *
 * @returns The `user` property from the parsed JSON response; may be `undefined` if the response does not include a `user` field.
 */
export async function getCurrentUser() {
  return await fetch('/data/page/index/auth/info', { headers: { accept: 'application/json' } }).then(async (res) =>
    (await res.json()).user,
  );
}