// Explicitly authenticated fixture requests. Security-denial tests keep using
// native fetch so a missing capability can never be silently supplied there.
export async function fleetFetch(url, options = {}) {
  const origin = new URL(url).origin;
  const bootstrap = await fetch(origin + "/api/bootstrap", {
    headers: { "X-Fleet-Bootstrap": "1" },
  });
  if (!bootstrap.ok)
    throw new Error(`Fixture bootstrap failed: ${bootstrap.status}`);
  const { csrf } = await bootstrap.json();
  return fetch(url, {
    ...options,
    headers: { "X-Fleet-Token": csrf, ...options.headers },
  });
}
