'use strict';
// 独立子进程中启动的测试服务器：DB_FILE 指向调用方指定的临时库
const fs = require('fs');
const db = require('../src/db/db');
const svc = require('../src/content/service');
const server = require('../src/api/server');

(async () => {
  await db.open(process.env.DB_FILE);
  svc.seedAll('test-seed');
  server.listen(Number(process.env.PORT), () => {
    console.log('READY ' + process.env.PORT);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
})();
