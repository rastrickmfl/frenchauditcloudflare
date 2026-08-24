-- Emulates the old Netlify Blobs get/setJSON key-value model on top of D1,
-- rather than fully normalizing — this maps directly onto the existing
-- getStore(name).get(key) / .setJSON(key, value) calls the three functions
-- used to make, so the functions themselves needed minimal rewriting.
--
-- `store` mirrors the old Netlify Blobs store name ("pupil-progress",
-- "classes", "teacher-lists"); `key` mirrors the blob key within that store
-- (a pupil account code, or the fixed strings "roster" / "lists").
CREATE TABLE IF NOT EXISTS kv_store (
  store      TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (store, key)
);
