const dbConfig = require('../lib/db-config');

module.exports = {
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL,
    directUrl: process.env.DIRECT_URL,
  },
  getDatabaseUrl: dbConfig.getDatabaseUrl,
  getDirectUrl: dbConfig.getDirectUrl,
};
