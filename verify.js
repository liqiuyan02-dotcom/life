const fs = require('fs');
const html = fs.readFileSync('F:/小Q的工作台/server/public/index.html', 'utf8');
const re = /<script>([\s\S]*?)<\/script>/g;
let m, i = 0, bad = 0;
while ((m = re.exec(html))) {
  i++;
  try { new Function(m[1]); }
  catch (e) { bad++; console.log('SCRIPT#' + i + ' ERROR: ' + e.message); }
}
const v = html.match(/BUILD_VERSION\s*=\s*['"]([^'"]+)['"]/);
console.log('scripts:', i, 'errors:', bad, 'BUILD_VERSION:', v ? v[1] : '?');
['checkBackupReminder', 'markBackedUp', 'wb_lastBackup'].forEach(k => console.log('has', k, ':', html.includes(k)));
