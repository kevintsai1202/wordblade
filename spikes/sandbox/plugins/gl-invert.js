// 測試插件：WebGL2 畫一格。把輸入畫面反相、右下角畫綠色方塊、x=900..1000 留一條透明帶。
// 用來驗證「ImageBitmap 進 → Worker 的 WebGL2 → ImageBitmap 出」的畫素正確性。
(function (g) {
  let gl, prog, tex, uRes;
  const VS = `#version 300 es
  void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0, 0, 1); }`;
  const FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex; uniform vec2 u_res; out vec4 o;
  void main(){
    vec2 p = gl_FragCoord.xy;
    vec4 c = texture(u_tex, vec2(p.x/u_res.x, 1.0 - p.y/u_res.y));
    vec4 r = vec4(1.0 - c.rgb, 1.0);
    if (p.x > u_res.x - 64.0 && p.y < 64.0) r = vec4(0.0, 1.0, 0.0, 1.0);
    if (p.x > 900.0 && p.x < 1000.0) r = vec4(0.0);
    o = r;
  }`;
  function sh(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  g.plugin = {
    /** 建立 WebGL2 context 與 shader；回傳 renderer 字串供記錄。 */
    init(canvas) {
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
      if (!gl) throw new Error('worker 拿不到 webgl2');
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      uRes = gl.getUniformLocation(prog, 'u_res');
      tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.viewport(0, 0, canvas.width, canvas.height);
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '', version: gl.getParameter(gl.VERSION) };
    },
    /** 畫一格：把輸入 bitmap 當貼圖，反相輸出。 */
    render(t, bitmap) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      gl.useProgram(prog);
      gl.uniform2f(uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    probe: (v) => g.__probes(v),
  };
})(globalThis);
