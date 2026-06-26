const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

function getDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is not set in .env');
  }
  return url;
}

function getDirectUrl() {
  return process.env.DIRECT_URL || getDatabaseUrl();
}

module.exports = {
  getDatabaseUrl,
  getDirectUrl,
};
