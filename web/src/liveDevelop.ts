import { liveParams, type Adjust, type LiveParams } from './develop'

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`

// Mismo revelado que developNegative (niveles por canal, inversion, exposicion, balance, contraste, color),
// pero calculado por la tarjeta grafica en cada cuadro de video.
const FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform float uExp;
uniform vec3 uGain;
uniform float uT;
uniform float uSat;
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  vec3 n = clamp((c - uLow) / max(uHigh - uLow, vec3(0.03)), 0.0, 1.0);
  vec3 p = clamp(pow(1.0 - n, vec3(uExp)) * uGain, 0.0, 1.0);
  vec3 s = p * p * (3.0 - 2.0 * p);
  p = clamp(p + uT * (s - p), 0.0, 1.0);
  float l = dot(p, vec3(0.299, 0.587, 0.114));
  p = clamp(vec3(l) + (p - vec3(l)) * uSat, 0.0, 1.0);
  gl_FragColor = vec4(p, 1.0);
}`

const STATS_WIDTH = 64
const STATS_EVERY_MS = 250
const SMOOTHING = 0.35
const MAX_BUFFER_WIDTH = 1280

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null
}

const lerp = (a: number, b: number) => a + (b - a) * SMOOTHING

function smoothParams(prev: LiveParams | null, next: LiveParams): LiveParams {
  if (!prev) return next
  const mix3 = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    lerp(a[0], b[0]),
    lerp(a[1], b[1]),
    lerp(a[2], b[2]),
  ]
  return {
    low: mix3(prev.low, next.low),
    high: mix3(prev.high, next.high),
    exponent: lerp(prev.exponent, next.exponent),
    gains: mix3(prev.gains, next.gains),
    contrast: next.contrast,
    saturation: next.saturation,
  }
}

/**
 * Muestra el video ya revelado en un canvas, a la velocidad de la camara. Cada cuarto de segundo mide un cuadro
 * diminuto para ajustar los niveles; el resto del trabajo lo hace la tarjeta grafica.
 * Devuelve la funcion para detenerlo, o null si el navegador no tiene WebGL (entonces se usa otro metodo).
 */
export function startLivePreview(video: HTMLVideoElement, canvas: HTMLCanvasElement, adjust: Adjust): (() => void) | null {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false })
  if (!gl) return null

  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX)
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()
  if (!vs || !fs || !program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
  gl.useProgram(program)

  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(program, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const texture = gl.createTexture()
  gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

  const u = {
    low: gl.getUniformLocation(program, 'uLow'),
    high: gl.getUniformLocation(program, 'uHigh'),
    exp: gl.getUniformLocation(program, 'uExp'),
    gain: gl.getUniformLocation(program, 'uGain'),
    t: gl.getUniformLocation(program, 'uT'),
    sat: gl.getUniformLocation(program, 'uSat'),
  }

  const stats = document.createElement('canvas')
  const statsCtx = stats.getContext('2d', { willReadFrequently: true })
  let params: LiveParams | null = null
  let lastStats = 0
  let frame = 0
  let stopped = false

  const render = (now: number) => {
    if (stopped) return
    frame = requestAnimationFrame(render)
    if (video.readyState < 2 || !video.videoWidth) return

    // El tamano de dibujo sigue al del video, con un tope para que sea ligero en el telefono.
    const w = Math.min(video.videoWidth, MAX_BUFFER_WIDTH)
    const h = Math.round((w * video.videoHeight) / video.videoWidth)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
      gl.viewport(0, 0, w, h)
    }

    if (statsCtx && (params === null || now - lastStats > STATS_EVERY_MS)) {
      lastStats = now
      stats.width = STATS_WIDTH
      stats.height = Math.max(1, Math.round((STATS_WIDTH * video.videoHeight) / video.videoWidth))
      statsCtx.drawImage(video, 0, 0, stats.width, stats.height)
      const { data } = statsCtx.getImageData(0, 0, stats.width, stats.height)
      params = smoothParams(params, liveParams(data, stats.width, stats.height, adjust))
    }
    if (!params) return

    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video)
    gl.uniform3f(u.low, ...params.low)
    gl.uniform3f(u.high, ...params.high)
    gl.uniform1f(u.exp, params.exponent)
    gl.uniform3f(u.gain, ...params.gains)
    gl.uniform1f(u.t, params.contrast)
    gl.uniform1f(u.sat, params.saturation)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  frame = requestAnimationFrame(render)

  return () => {
    stopped = true
    cancelAnimationFrame(frame)
  }
}
