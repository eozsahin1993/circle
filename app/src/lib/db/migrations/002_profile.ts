export const sql = `
  CREATE TABLE device_profile (
    id INTEGER PRIMARY KEY CHECK (id = 0),
    name TEXT NOT NULL,
    picture BLOB,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL
  );
`;
