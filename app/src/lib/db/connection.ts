import { openDatabaseSync } from 'expo-sqlite';

/**
 * The single shared database handle. Nothing in this file depends on any
 * other db/ module — keeps migrations.ts, circles.ts, and members.ts free
 * to import this without risking a circular dependency back through
 * index.ts.
 */
export const db = openDatabaseSync('hearth.db');
