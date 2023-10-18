export async function getCurrentUser() {
  return await fetch('/data/page/index/auth/info', { headers: { accept: 'application/json' } }).then(async (res) =>
    (await res.json()).user,
  );
}
