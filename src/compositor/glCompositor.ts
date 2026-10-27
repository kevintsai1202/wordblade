// WebGL2 合成器（D24）：把影像來源（<video>、VideoFrame、ImageBitmap）依框與透明度疊到畫布上。
// 預覽與匯出共用；這一版先做影像圖層，3D、插件、字幕之後照 §5.10 的順序接上。
import type { Rect } from "../core/model";

/** 頂點著色器：單位正方形依 rect（0～1、左上原點）放到畫面上 */
const VERTEX = `#version 300 es
in vec2 pos;
uniform vec4 rect;
out vec2 uv;
void main() {
  uv = pos;
  vec2 p = vec2(rect.x + pos.x * rect.z, 1.0 - (rect.y + pos.y * rect.w));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** 片段著色器：取貼圖的 uvRect 範圍（局部放大，§5.19；預設整張），乘上透明度（預乘 alpha） */
const FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D tex;
uniform float opacity;
uniform vec4 uvRect;
out vec4 color;
void main() { color = texture(tex, uvRect.xy + uv * uvRect.zw) * opacity; }`;

/** 整張貼圖 */
const FULL_UV: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** WebGL2 合成器 */
export class GlCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly rectLoc: WebGLUniformLocation;
  private readonly opacityLoc: WebGLUniformLocation;
  private readonly uvRectLoc: WebGLUniformLocation;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    const program = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader error");
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(program, "pos");
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
    this.rectLoc = gl.getUniformLocation(program, "rect")!;
    this.opacityLoc = gl.getUniformLocation(program, "opacity")!;
    this.uvRectLoc = gl.getUniformLocation(program, "uvRect")!;
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** 開始新的一格：依畫布大小設定視區並清成黑色 */
  begin() {
    const { gl } = this;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** 把一個影像來源畫到 rect，透明度 opacity；crop：只取來源的這個範圍（0～1，左上原點；局部放大用） */
  draw(source: TexImageSource, rect: Rect, opacity: number, crop: Rect = FULL_UV) {
    const { gl } = this;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform4f(this.rectLoc, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(this.opacityLoc, opacity);
    gl.uniform4f(this.uvRectLoc, crop.x, crop.y, crop.w, crop.h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
