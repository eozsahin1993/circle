export const sql = `
  CREATE TABLE circles (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME NOT NULL
  );

  CREATE TABLE circle_members (
    circle_id TEXT NOT NULL REFERENCES circles(id) ON DELETE CASCADE,
    public_key TEXT NOT NULL,
    member_id TEXT NOT NULL,
    name TEXT NOT NULL,
    picture BLOB,
    joined_at DATETIME NOT NULL,
    PRIMARY KEY (circle_id, public_key)
  );

  CREATE UNIQUE INDEX circle_members_member_id
    ON circle_members (circle_id, member_id);
`;
