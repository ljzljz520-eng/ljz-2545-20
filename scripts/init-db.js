'use strict';
// 初始化数据库（删除旧文件可重建）
process.env.DB_FILE = process.env.DB_FILE || require('path').join(__dirname, '..', 'data', 'app.db');
const db = require('../src/db/db');
const svc = require('../src/content/service');

(async () => {
  await db.open(process.env.DB_FILE);
  svc.seedAll('system');
  const c = db.get('SELECT COUNT(*) AS n FROM doc_versions');
  console.log(`initialized ${process.env.DB_FILE}: ${c.n} doc version(s)`);
  await db.close();
})();
