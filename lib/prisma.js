const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { getDatabaseUrl } = require('./db-config');

let prisma = null;
let pool = null;
let initError = null;

function createPrismaClient() {
  if (initError) {
    throw initError;
  }
  try {
    const connectionString = getDatabaseUrl();
    const adapter = new PrismaPg({ connectionString });
    return new PrismaClient({ adapter });
  } catch (error) {
    initError = error;
    throw error;
  }
}

function getPrisma() {
  if (!prisma) {
    prisma = createPrismaClient();
  }
  return prisma;
}

async function disconnectPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
  if (pool) {
    await pool.end();
    pool = null;
  }
  initError = null;
}

async function safeQuery(fn) {
  try {
    const client = getPrisma();
    return { ok: true, data: await fn(client) };
  } catch (error) {
    const isInit = error?.name === 'PrismaClientInitializationError';
    return {
      ok: false,
      status: 'DB_ERROR',
      error: error?.message || String(error),
      isInit,
    };
  }
}

module.exports = {
  getPrisma,
  createPrismaClient,
  disconnectPrisma,
  safeQuery,
};
