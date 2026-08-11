// 用 Chromium 的 GPU 特性查询 API 直接看显卡支持情况
const { app } = require('electron');
app.commandLine.appendSwitch('enable-logging');
app.commandLine.appendSwitch('v', '1');
app.whenReady().then(() => {
  const { webContents } = require('electron');
  const win = new (require('electron').BrowserWindow)({ show: false });
  win.webContents.on('console-message', (_, level, msg) => {
    if (msg.includes('SwiftShader') || msg.includes('Vulkan') || msg.includes('ANGLE') || msg.includes('GPU') || msg.includes('WebGL'))
      console.log('[gpu]', msg);
  });
  win.loadURL('chrome://gpu').then(() => {
    setTimeout(async () => {
      const info = await win.webContents.executeJavaScript(`
        (() => {
          const grab = (label) => Array.from(document.querySelectorAll('div'))
            .filter(d => d.textContent.startsWith(label))
            .map(d => d.textContent.replace(label, '').trim()).slice(0,3);
          return {
            title: document.title,
            graphicsFeatureStatus: grab('Graphics Feature Status')[0] || '',
            sampleLines: grab('').slice(0, 40).filter(s => /Hardware|Software|Disabled|WebGL|Vulkan|SwiftShader|ANGLE/i.test(s))
          };
        })();
      `);
      console.log('=== chrome://gpu ===');
      console.log(JSON.stringify(info, null, 2));
      app.exit(0);
    }, 3000);
  });
});
