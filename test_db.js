const { getPrisma, disconnectPrisma, safeQuery } = require('./lib/prisma');

async function main() {
  console.log('در حال تلاش برای اتصال به PostgreSQL (Prisma v7)...');
  const result = await safeQuery((prisma) => prisma.$queryRaw`SELECT 1 AS ok`);

  if (result.ok) {
    console.log('✅ اتصال با موفقیت برقرار شد!', result.data);
  } else {
    console.error('❌ خطای اتصال:', result.error);
    if (result.isInit) {
      console.error('💡 PrismaClientInitializationError — DATABASE_URL را در .env بررسی کنید.');
    }
    if (result.status === 'DB_ERROR') {
      process.exitCode = 1;
    }
  }
}

main()
  .catch((error) => {
    console.error('❌ خطای غیرمنتظره:', error.message);
    process.exitCode = 1;
  })
  .finally(() => disconnectPrisma());
