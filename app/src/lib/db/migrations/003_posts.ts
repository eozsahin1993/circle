export const sql = `
  CREATE TABLE posts (
    id TEXT PRIMARY KEY NOT NULL,
    circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    caption TEXT NOT NULL,
    photo BLOB NOT NULL,
    created_at DATETIME NOT NULL
  );

  CREATE INDEX posts_circle_id ON posts (circle_id);
`;
