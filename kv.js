// Thin key-value layer on top of D1's kv_store table, standing in for the
// old @netlify/blobs getStore(name).get(key)/.setJSON(key, value) calls.
// Keeping this shape means each route handler below reads almost exactly
// like its Netlify Functions predecessor.

export async function kvGet(env, store, key) {
  const row = await env.DB.prepare(
    "SELECT value FROM kv_store WHERE store = ? AND key = ?"
  ).bind(store, key).first();
  if (!row) return null;
  return JSON.parse(row.value);
}

export async function kvSet(env, store, key, value) {
  await env.DB.prepare(
    `INSERT INTO kv_store (store, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(store, key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`
  ).bind(store, key, JSON.stringify(value), new Date().toISOString()).run();
}

export function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
