// Diagnostic for the Trellus hookup. Run: npm run trellus:probe
//
// Prints two things:
//   1. Which PROSPECT_INFO column actually holds the prospect's phone number.
//      That is the join key to Zoho, so it has to be right or nothing matches.
//   2. The raw tracker entries on one recent session, so you can confirm the
//      tracker names in scripts/config.json match what Trellus is writing.
import { probe, trellusEnabled } from './trellus.js';

if (!trellusEnabled()) {
  console.error('\nSet TRELLUS_API_KEY and TRELLUS_TEAM_ID first.\n' +
                'Locally:  export TRELLUS_API_KEY=... TRELLUS_TEAM_ID=...\n');
  process.exit(1);
}

await probe();
