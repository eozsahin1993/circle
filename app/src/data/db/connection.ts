import { openDatabaseSync } from 'expo-sqlite';
import { drizzle } from 'drizzle-orm/expo-sqlite';

import * as schema from '@/data/db/schema';

/**
 * The single shared database handle. Nothing in this file depends on any
 * other db/ module — keeps migrations, circles.ts, and members.ts free
 * to import this without risking a circular dependency back through
 * index.ts.
 */
export const db = drizzle(openDatabaseSync('hearth.db'), { schema });
