/**
 * Fetches the current authenticated user's information from the server.
 *
 * @returns The value of the `user` property from the JSON response.
 */
export async function getCurrentUser() {
  return await fetch('/data/page/index/auth/info', { headers: { accept: 'application/json' } }).then(async (res) =>
    (await res.json()).user,
  );
}