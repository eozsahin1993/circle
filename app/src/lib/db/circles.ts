import { db } from '@/lib/db/connection';

export type Circle = {
  id: string;
  name: string;
  createdAt: number;
};

const CIRCLE_COLUMNS = `id, name, created_at AS createdAt`;

export async function insertCircle(circle: Circle): Promise<void> {
  await db.runAsync(
    'INSERT INTO circles (id, name, created_at) VALUES (?, ?, ?)',
    circle.id,
    circle.name,
    circle.createdAt,
  );
}

export function getCircle(id: string): Promise<Circle | null> {
  return db.getFirstAsync<Circle>(`SELECT ${CIRCLE_COLUMNS} FROM circles WHERE id = ?`, id);
}

export function getAllCircles(): Promise<Circle[]> {
  return db.getAllAsync<Circle>(`SELECT ${CIRCLE_COLUMNS} FROM circles ORDER BY created_at`);
}

export async function updateCircleName(id: string, name: string): Promise<void> {
  await db.runAsync('UPDATE circles SET name = ? WHERE id = ?', name, id);
}

/** Deletes a circle and, via ON DELETE CASCADE, its entire roster with it. */
export async function deleteCircle(id: string): Promise<void> {
  await db.runAsync('DELETE FROM circles WHERE id = ?', id);
}
