#!/usr/bin/env node
'use strict';
// SQL 自查：node tools/sql.js "SELECT ..."  （只读）
const path = require('path');
const initSqlJs = require('sql.js');
(async () => {
  const SQL = await initSqlJs({ locateFile: f => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f) });
  const db = new SQL.Database(require('fs').readFileSync(process.env.DS_DB_FILE || path.join(__dirname, '..', 'data', 'app.sqlite')));
  const sql = process.argv[2] || "SELECT d.slug, d.live_version, v.status FROM docs d JOIN doc_versions v ON v.doc_id=d.id ORDER BY v.version";
  const res = db.exec(sql);
  if (!res.length) { console.log('(no rows)'); return; }
  const cols = res[0].columns;
  console.log(cols.join('\t'));
  for (const r of res[0].values) console.log(r.join('\t'));
})();
