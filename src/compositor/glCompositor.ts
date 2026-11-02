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
// 色彩調整（P3；2026-11-02）：grade＝(亮度, 對比, 飽和度, 色溫)，−1～1，0 不變。先還原預乘 alpha 再調，調完再乘回去。
uniform vec4 grade;
vec4 applyGrade(vec4 c) {
  if (grade == vec4(0.0) || c.a <= 0.0) return c;
  vec3 rgb = c.rgb / c.a;
  rgb += grade.x * 0.4;
  rgb = (rgb - 0.5) * (1.0 + grade.y) + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, 1.0 + grade.z);
  rgb += vec3(0.1, 0.0, -0.1) * grade.w;
  return vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}
void main() { color = applyGrade(texture(tex, uvRect.xy + uv * uvRect.zw)) * opacity; }`;

/**
 * 遮罩著色器（SAM，§5.3）：mask 貼圖蓋住整個來源畫面（素材座標），和影片用同一個 uvRect 取樣，放大裁切也對得上；
 * 遮罩外 discard。mode 0 馬賽克（格子內取 4 點平均）、1 模糊（7×7 高斯）、2 純色。block、radius 是來源貼圖座標的大小。
 */
const MASK_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D tex;
uniform sampler2D mask;
uniform float opacity;
uniform vec4 uvRect;
uniform int mode;
uniform vec2 block;
uniform vec2 radius;
uniform vec3 solid;
out vec4 color;
// 色彩調整（P3；2026-11-02）：grade＝(亮度, 對比, 飽和度, 色溫)，−1～1，0 不變。先還原預乘 alpha 再調，調完再乘回去。
uniform vec4 grade;
vec4 applyGrade(vec4 c) {
  if (grade == vec4(0.0) || c.a <= 0.0) return c;
  vec3 rgb = c.rgb / c.a;
  rgb += grade.x * 0.4;
  rgb = (rgb - 0.5) * (1.0 + grade.y) + 0.5;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, 1.0 + grade.z);
  rgb += vec3(0.1, 0.0, -0.1) * grade.w;
  return vec4(clamp(rgb, 0.0, 1.0) * c.a, c.a);
}
void main() {
  vec2 suv = uvRect.xy + uv * uvRect.zw;
  if (texture(mask, suv).r < 0.1) discard;
  vec4 c;
  if (mode == 0) {
    vec2 o = (floor(suv / block)) * block;
    c = (texture(tex, o + block * vec2(0.25, 0.25)) + texture(tex, o + block * vec2(0.75, 0.25))
       + texture(tex, o + block * vec2(0.25, 0.75)) + texture(tex, o + block * vec2(0.75, 0.75))) * 0.25;
  } else if (mode == 1) {
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int y = -3; y <= 3; y++) {
      for (int x = -3; x <= 3; x++) {
        float w = exp(-float(x * x + y * y) / 4.5);
        sum += texture(tex, suv + vec2(float(x), float(y)) * radius / 3.0) * w;
        wsum += w;
      }
    }
    c = sum / wsum;
  } else {
    c = vec4(solid, 1.0);
  }
  if (mode != 2) c = applyGrade(c);
  color = c * opacity;
}`;

/** 遮罩效果的參數（drawMasked） */
export interface MaskEffect {
  mode: "mosaic" | "blur" | "solid";
  /** 馬賽克格子大小（來源貼圖座標） */
  block: [number, number];
  /** 模糊半徑（來源貼圖座標） */
  radius: [number, number];
  /** 純色（0～1） */
  solid: [number, number, number];
}

/** 色彩調整的四個值（−1～1） */
export interface Grade {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
}

/** 整張貼圖 */
const FULL_UV: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** WebGL2 合成器 */
export class GlCompositor {
  private readonly gl: WebGL2RenderingContext;
  private readonly rectLoc: WebGLUniformLocation;
  private readonly opacityLoc: WebGLUniformLocation;
  private readonly uvRectLoc: WebGLUniformLocation;
  private readonly gradeLoc: WebGLUniformLocation;
  private readonly program: WebGLProgram;
  /** 純色用的 1×1 白色貼圖（穿黑／白轉場；第一次用到才建） */
  private solidTex: WebGLTexture | null = null;
  /** 遮罩用的程式與貼圖（第一次用到才建） */
  private maskProgram: { program: WebGLProgram; loc: Record<string, WebGLUniformLocation>; maskTex: WebGLTexture; videoTex: WebGLTexture } | null = null;
  private readonly tex: WebGLTexture;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { alpha: false, premultipliedAlpha: true, preserveDrawingBuffer: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    const program = this.link(FRAGMENT);
    this.program = program;
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.rectLoc = gl.getUniformLocation(program, "rect")!;
    this.opacityLoc = gl.getUniformLocation(program, "opacity")!;
    this.uvRectLoc = gl.getUniformLocation(program, "uvRect")!;
    this.gradeLoc = gl.getUniformLocation(program, "grade")!;
    this.tex = this.texture();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** 編譯並連結一個程式（頂點著色器共用，pos 固定在位置 0） */
  private link(fragment: string): WebGLProgram {
    const { gl } = this;
    const program = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
      const shader = gl.createShader(type)!;
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader error");
      gl.attachShader(program, shader);
    }
    gl.bindAttribLocation(program, 0, "pos");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link error");
    return program;
  }

  /** 新的貼圖（線性取樣、邊緣夾住） */
  private texture(): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** 開始新的一格：依畫布大小設定視區並清成黑色 */
  begin() {
    const { gl } = this;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** 把一個影像來源畫到 rect，透明度 opacity；crop：只取來源的這個範圍（0～1，左上原點；局部放大用）；grade：色彩調整 */
  draw(source: TexImageSource, rect: Rect, opacity: number, crop: Rect = FULL_UV, grade?: Grade) {
    const { gl } = this;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.uniform4f(this.rectLoc, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(this.opacityLoc, opacity);
    gl.uniform4f(this.uvRectLoc, crop.x, crop.y, crop.w, crop.h);
    gl.uniform4f(this.gradeLoc, grade?.brightness ?? 0, grade?.contrast ?? 0, grade?.saturation ?? 0, grade?.temperature ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** 整個畫面蓋一層純色（rgb 0～1），透明度 opacity（穿黑／白轉場，§5.9） */
  drawSolid(rgb: [number, number, number], opacity: number) {
    const { gl } = this;
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    if (!this.solidTex) this.solidTex = this.texture();
    gl.bindTexture(gl.TEXTURE_2D, this.solidTex);
    const px = new Uint8Array([Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255), 255]);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.uniform4f(this.rectLoc, 0, 0, 1, 1);
    gl.uniform1f(this.opacityLoc, opacity);
    gl.uniform4f(this.uvRectLoc, 0, 0, 1, 1);
    gl.uniform4f(this.gradeLoc, 0, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * 遮罩（SAM，§5.3）：在影像圖層上、遮罩範圍內再畫一次套了效果的影像。source、rect、opacity、crop 和那個圖層的 draw 一樣；
   * mask：蓋住整個來源畫面的遮罩圖（紅色通道 ≥ 0.1 的地方套效果）。
   */
  drawMasked(source: TexImageSource, rect: Rect, opacity: number, crop: Rect, mask: TexImageSource, effect: MaskEffect, grade?: Grade) {
    const { gl } = this;
    if (!this.maskProgram) {
      const program = this.link(MASK_FRAGMENT);
      const loc: Record<string, WebGLUniformLocation> = {};
      for (const name of ["rect", "opacity", "uvRect", "tex", "mask", "mode", "block", "radius", "solid", "grade"]) loc[name] = gl.getUniformLocation(program, name)!;
      this.maskProgram = { program, loc, maskTex: this.texture(), videoTex: this.texture() };
    }
    const { program, loc, maskTex, videoTex } = this.maskProgram;
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
    gl.uniform1i(loc.tex, 0);
    gl.uniform1i(loc.mask, 1);
    gl.uniform4f(loc.rect, rect.x, rect.y, rect.w, rect.h);
    gl.uniform1f(loc.opacity, opacity);
    gl.uniform4f(loc.uvRect, crop.x, crop.y, crop.w, crop.h);
    gl.uniform1i(loc.mode, effect.mode === "mosaic" ? 0 : effect.mode === "blur" ? 1 : 2);
    gl.uniform2f(loc.block, effect.block[0], effect.block[1]);
    gl.uniform2f(loc.radius, effect.radius[0], effect.radius[1]);
    gl.uniform3f(loc.solid, effect.solid[0], effect.solid[1], effect.solid[2]);
    gl.uniform4f(loc.grade, grade?.brightness ?? 0, grade?.contrast ?? 0, grade?.saturation ?? 0, grade?.temperature ?? 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.activeTexture(gl.TEXTURE0);
  }
}
