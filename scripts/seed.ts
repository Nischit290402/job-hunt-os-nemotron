/** Loads seed/ into the database. Usage: npm run db:seed (safe to re-run). */
import './_env';
import { readFileSync } from 'node:fs';
import { getSql } from '../src/server/sql';
import { seed } from '../src/server/seed';

const sources = JSON.parse(readFileSync('seed/sources.json', 'utf8'));
const profile = readFileSync('seed/profile.md', 'utf8');
const data = JSON.parse(readFileSync('seed/seed.json', 'utf8'));
console.log(await seed(await getSql(), sources, profile, data));
