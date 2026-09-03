// This file is required for Expo/React Native SQLite migrations - https://orm.drizzle.team/quick-sqlite/expo

import journal from './meta/_journal.json';
import m0000 from './0000_clumsy_paper_doll.sql';
import m0001 from './0001_mature_zuras.sql';
import m0002 from './0002_rare_professor_monster.sql';
import m0003 from './0003_wandering_hardball.sql';
import m0004 from './0004_adorable_violations.sql';
import m0005 from './0005_purple_darwin.sql';

  export default {
    journal,
    migrations: {
      m0000,
      m0001,
      m0002,
      m0003,
      m0004,
      m0005
    }
  }
  