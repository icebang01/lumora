// 幂等地把指定文件统一为 LF（与仓库 .gitattributes 策略一致；AGENTS.md 铁律 #2）。
// 用法: node tools/fix-crlf.js <file...>
const fs = require('fs');
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f);
  if (buf.includes(Buffer.from([13, 10])) || buf.includes(Buffer.from([13]))) {
    fs.writeFileSync(f, buf.toString('utf8').replace(/\r\n?/g, '\n'));
    console.log('LF 转换: ' + f);
  } else {
    console.log('已是 LF: ' + f);
  }
}
