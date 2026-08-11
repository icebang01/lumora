// 真正在渲染进程里探 WebGL2，看主时钟/着色器/纹理能用到哪一档
const { app, BrowserWindow } = require('electron');
app.commandLine.appendSwitch('enable-logging');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  await win.loadURL('data:text/html,<canvas id=c></canvas>');
  const r = await win.webContents.executeJavaScript(`
    (() => {
      const c = document.getElementById('c');
      const out = { ua: navigator.userAgent };
      // 1. WebGL2 直探
      let gl2 = c.getContext('webgl2');
      out.webgl2 = !!gl2;
      if (gl2) {
        const dbg = gl2.getExtension('WEBGL_debug_renderer_info');
        out.glVendor = dbg ? gl2.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'n/a';
        out.glRenderer = dbg ? gl2.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a';
        out.maxTex = gl2.getParameter(gl2.MAX_TEXTURE_SIZE);
        out.floatRT = !!gl2.getExtension('EXT_color_buffer_float');
      }
      // 2. WebGL1
      let gl1 = gl2 ? null : c.getContext('webgl');
      out.webgl1 = !!gl1;
      // 3. 着色器最小可用性
      if (gl2) {
        const s = gl2.createShader(gl2.FRAGMENT_SHADER);
        gl2.shaderSource(s, '#version 300 es\\nprecision mediump float;out vec4 o;void main(){o=vec4(1);}');
        gl2.compileShader(s);
        out.shaderCompileOK = gl2.getShaderParameter(s, gl2.COMPILE_STATUS);
      }
      return out;
    })();
  `);
  console.log('PROBE=' + JSON.stringify(r));
  app.exit(0);
});
