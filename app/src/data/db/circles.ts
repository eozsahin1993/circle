import { asc, eq } from 'drizzle-orm';

import { db } from '@/data/db/connection';
import { circles } from '@/data/db/schema';

export type Circle = typeof circles.$inferSelect;

export async function insertCircle(circle: Circle): Promise<void> {
  await db.insert(circles).values(circle);
}

export async function getCircle(id: string): Promise<Circle | null> {
  const rows = await db.select().from(circles).where(eq(circles.id, id));
  return rows[0] ?? null;
}

export function getAllCircles(): Promise<Circle[]> {
  return db.select().from(circles).orderBy(asc(circles.createdAt));
}

export async function updateCircleName(id: string, name: string): Promise<void> {
  await db.update(circles).set({ name }).where(eq(circles.id, id));
}

/** Deletes a circle and, via ON DELETE CASCADE, its entire roster with it. */
export async function deleteCircle(id: string): Promise<void> {
  await db.delete(circles).where(eq(circles.id, id));
}
