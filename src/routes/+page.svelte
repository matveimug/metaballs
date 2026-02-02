<script>
  import { onMount } from "svelte";
  import * as THREE from "three";

  let containerEl;
  let canvasEl;

  let cellSize = 100;
  let gridWidthUnits = 10;
  let gridHeightUnits = 10;
  let defaultDiameter = 1;
  let randomCount = 10;
  let blurRadius = 3;
  let blurIterations = 15;
  let showGrid = true;

  let gridX = 0;
  let gridY = 0;
  let activeCount = 0;
  let canvasWidthPx = 0;
  let canvasHeightPx = 0;
  let lastGridKey = "";

  const MAX_GRID = 120;
  const MAX_RANDOM = 40;
  const circles = new Map();

  let isDragging = false;
  let dragStartCell = { x: 0, y: 0 };
  let activeCircleKey = null;
  let startedOnCircleKey = null;
  let dragMoved = false;
  let lastRandomCount = randomCount;

  let renderer;
  let scene;
  let camera;
  let quad;
  let blurMaterial;
  let finalMaterial;
  let rtA;
  let rtB;
  let maskCanvas;
  let maskCtx;
  let maskTexture;
  let needsRender = false;
  let rafId;
  let internalWidth = 1;
  let internalHeight = 1;

  let renderScale = 1.5;
  const MAX_INTERNAL = 2048;
  const MAX_BLUR = 24;
  const MAX_ITER = 24;

  const vertexShader = `
		varying vec2 vUv;
		void main() {
			vUv = uv;
			gl_Position = vec4(position, 1.0);
		}
	`;

  const blurFragment = `
		precision highp float;
		varying vec2 vUv;
		uniform sampler2D uInput;
		uniform vec2 uResolution;
		uniform vec2 uDirection;
		uniform float uRadius;

		void main() {
			vec2 texel = uDirection / uResolution;
			float r = max(0.0, uRadius);
			vec4 color = texture2D(uInput, vUv) * 0.227027;
			color += texture2D(uInput, vUv + texel * (1.0 * r)) * 0.1945946;
			color += texture2D(uInput, vUv - texel * (1.0 * r)) * 0.1945946;
			color += texture2D(uInput, vUv + texel * (2.0 * r)) * 0.1216216;
			color += texture2D(uInput, vUv - texel * (2.0 * r)) * 0.1216216;
			color += texture2D(uInput, vUv + texel * (3.0 * r)) * 0.054054;
			color += texture2D(uInput, vUv - texel * (3.0 * r)) * 0.054054;
			color += texture2D(uInput, vUv + texel * (4.0 * r)) * 0.016216;
			color += texture2D(uInput, vUv - texel * (4.0 * r)) * 0.016216;
			gl_FragColor = color;
		}
	`;

  const finalFragment = `
		precision highp float;
		varying vec2 vUv;
		uniform sampler2D uInput;
		uniform float uThreshold;
		void main() {
			float v = texture2D(uInput, vUv).r;
			float t = step(uThreshold, v);
			vec3 color = vec3(0.0);
			gl_FragColor = vec4(color, t);
		}
	`;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function updateGridCounts() {
    const nextX = sanitizeGridUnits(gridWidthUnits, gridX || 10);
    const nextY = sanitizeGridUnits(gridHeightUnits, gridY || 10);
    const safeCellSize = sanitizeCellSize(cellSize, 100);
    cellSize = safeCellSize;
    gridX = nextX;
    gridY = nextY;
    gridWidthUnits = gridX;
    gridHeightUnits = gridY;
    canvasWidthPx = gridX * cellSize;
    canvasHeightPx = gridY * cellSize;
  }

  function sanitizeGridUnits(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return clamp(Math.round(n), 1, MAX_GRID);
  }

  function sanitizeCellSize(value, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return clamp(Math.round(n), 10, 400);
  }

  function getCanvasSizePx() {
    return {
      width: canvasWidthPx,
      height: canvasHeightPx,
    };
  }

  function getRenderScale() {
    return clamp(Number(renderScale) || 1, 0.5, 1.5);
  }

  function getEffectiveRenderScale(width, height) {
    const base = getRenderScale();
    const maxScaleX = MAX_INTERNAL / Math.max(1, width);
    const maxScaleY = MAX_INTERNAL / Math.max(1, height);
    return Math.max(0.5, Math.min(base, maxScaleX, maxScaleY));
  }

  function keyFromHalf(xHalf, yHalf) {
    return `${xHalf},${yHalf}`;
  }

  function addCircleAt(xHalf, yHalf, diameter) {
    if (!isValidCenterHalf(xHalf, yHalf, diameter)) return false;
    const key = keyFromHalf(xHalf, yHalf);
    if (circles.has(key)) return false;
    circles.set(key, { xHalf, yHalf, diameter });
    return true;
  }

  function updateActiveCount() {
    activeCount = circles.size;
  }

  function isValidCenterHalf(xHalf, yHalf, diameter) {
    const centerX = xHalf / 2;
    const centerY = yHalf / 2;
    const radius = diameter / 2;
    return (
      centerX - radius >= 0 &&
      centerX + radius <= gridX &&
      centerY - radius >= 0 &&
      centerY + radius <= gridY
    );
  }

  function setActiveCircle(xHalf, yHalf, diameter) {
    const snapped = clamp(Math.round(diameter), 1, MAX_GRID);
    if (!isValidCenterHalf(xHalf, yHalf, snapped)) return;
    if (activeCircleKey) circles.delete(activeCircleKey);
    const key = keyFromHalf(xHalf, yHalf);
    circles.set(key, { xHalf, yHalf, diameter: snapped });
    activeCircleKey = key;
    updateActiveCount();
    markDirty();
  }

  function clearMask() {
    circles.clear();
    updateActiveCount();
    markDirty();
  }

  function exportPng() {
    if (!renderer) return;
    render();
    const link = document.createElement("a");
    link.href = renderer.domElement.toDataURL("image/png");
    link.download = "metaballs.png";
    link.click();
  }

  function exportSvg() {
    if (!renderer || !rtB) return;
    render();
    const width = internalWidth;
    const height = internalHeight;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rtB, 0, 0, width, height, pixels);
    const paths = traceContours(pixels, width, height, 128);
    const { width: outW, height: outH } = getCanvasSizePx();
    const scaleX = outW / width;
    const scaleY = outH / height;
    const pathData = paths
      .map((poly) => {
        const d = poly
          .map((pt, idx) => {
            const x = (pt.x * scaleX).toFixed(2);
            const y = ((height - pt.y) * scaleY).toFixed(2);
            return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
          })
          .join(" ");
        return `${d} Z`;
      })
      .join(" ");
    const svg =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">\n` +
      `  <rect width="100%" height="100%" fill="white"/>\n` +
      `  <path d="${pathData}" fill="black" stroke="none"/>\n` +
      `</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "metaballs.svg";
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function traceContours(pixels, width, height, threshold) {
    const getValue = (x, y) => {
      const idx = (y * width + x) * 4;
      return pixels[idx] >= threshold ? 1 : 0;
    };
    const segments = [];
    for (let y = 0; y < height - 1; y += 1) {
      for (let x = 0; x < width - 1; x += 1) {
        const tl = getValue(x, y);
        const tr = getValue(x + 1, y);
        const br = getValue(x + 1, y + 1);
        const bl = getValue(x, y + 1);
        const code = tl * 8 + tr * 4 + br * 2 + bl * 1;
        const x0 = x;
        const y0 = y;
        const x1 = x + 1;
        const y1 = y + 1;
        const xm = x + 0.5;
        const ym = y + 0.5;
        switch (code) {
          case 1:
          case 14:
            segments.push([
              { x: x0, y: ym },
              { x: xm, y: y1 },
            ]);
            break;
          case 2:
          case 13:
            segments.push([
              { x: xm, y: y1 },
              { x: x1, y: ym },
            ]);
            break;
          case 3:
          case 12:
            segments.push([
              { x: x0, y: ym },
              { x: x1, y: ym },
            ]);
            break;
          case 4:
          case 11:
            segments.push([
              { x: xm, y: y0 },
              { x: x1, y: ym },
            ]);
            break;
          case 5:
            segments.push([
              { x: xm, y: y0 },
              { x: x0, y: ym },
            ]);
            segments.push([
              { x: x1, y: ym },
              { x: xm, y: y1 },
            ]);
            break;
          case 6:
          case 9:
            segments.push([
              { x: xm, y: y0 },
              { x: xm, y: y1 },
            ]);
            break;
          case 7:
          case 8:
            segments.push([
              { x: xm, y: y0 },
              { x: x0, y: ym },
            ]);
            break;
          case 10:
            segments.push([
              { x: xm, y: y0 },
              { x: x1, y: ym },
            ]);
            segments.push([
              { x: x0, y: ym },
              { x: xm, y: y1 },
            ]);
            break;
          default:
            break;
        }
      }
    }
    const rawPaths = stitchSegments(segments);
    return rawPaths
      .map((path) => simplifyPath(path, 1))
      .map((path) => smoothPath(path, 2));
  }

  function stitchSegments(segments) {
    const pointKey = (p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    const adjacency = new Map();
    const unused = new Set();
    segments.forEach((seg, i) => {
      const [a, b] = seg;
      const ka = pointKey(a);
      const kb = pointKey(b);
      if (!adjacency.has(ka)) adjacency.set(ka, []);
      if (!adjacency.has(kb)) adjacency.set(kb, []);
      adjacency.get(ka).push({ idx: i, to: b });
      adjacency.get(kb).push({ idx: i, to: a });
      unused.add(i);
    });

    const paths = [];
    while (unused.size > 0) {
      const [firstIdx] = unused;
      unused.delete(firstIdx);
      const [a, b] = segments[firstIdx];
      const path = [a, b];

      const extend = (atStart) => {
        let current = atStart ? path[0] : path[path.length - 1];
        let guard = 0;
        while (guard < 100000) {
          guard += 1;
          const key = pointKey(current);
          const options = adjacency.get(key) || [];
          const nextOption = options.find((opt) => unused.has(opt.idx));
          if (!nextOption) break;
          unused.delete(nextOption.idx);
          if (atStart) {
            path.unshift(nextOption.to);
            current = path[0];
          } else {
            path.push(nextOption.to);
            current = path[path.length - 1];
          }
        }
      };

      extend(false);
      extend(true);
      if (path.length > 2) paths.push(path);
    }
    return paths;
  }

  function simplifyPath(points, epsilon) {
    if (points.length < 3) return points;
    const keep = new Array(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;

    const distPointToSegment = (p, a, b) => {
      const vx = b.x - a.x;
      const vy = b.y - a.y;
      const wx = p.x - a.x;
      const wy = p.y - a.y;
      const c1 = vx * wx + vy * wy;
      if (c1 <= 0) return Math.hypot(p.x - a.x, p.y - a.y);
      const c2 = vx * vx + vy * vy;
      if (c2 <= c1) return Math.hypot(p.x - b.x, p.y - b.y);
      const t = c1 / c2;
      const px = a.x + t * vx;
      const py = a.y + t * vy;
      return Math.hypot(p.x - px, p.y - py);
    };

    const stack = [[0, points.length - 1]];
    while (stack.length) {
      const [start, end] = stack.pop();
      let maxDist = 0;
      let index = -1;
      for (let i = start + 1; i < end; i += 1) {
        const d = distPointToSegment(points[i], points[start], points[end]);
        if (d > maxDist) {
          maxDist = d;
          index = i;
        }
      }
      if (maxDist > epsilon && index !== -1) {
        keep[index] = true;
        stack.push([start, index], [index, end]);
      }
    }

    return points.filter((_, i) => keep[i]);
  }

  function smoothPath(points, iterations) {
    if (points.length < 3) return points;
    let result = points;
    for (let iter = 0; iter < iterations; iter += 1) {
      const next = [];
      for (let i = 0; i < result.length; i += 1) {
        const p0 = result[i];
        const p1 = result[(i + 1) % result.length];
        const q = {
          x: 0.75 * p0.x + 0.25 * p1.x,
          y: 0.75 * p0.y + 0.25 * p1.y,
        };
        const r = {
          x: 0.25 * p0.x + 0.75 * p1.x,
          y: 0.25 * p0.y + 0.75 * p1.y,
        };
        next.push(q, r);
      }
      result = next;
    }
    return result;
  }

  function randomizeCircles() {
    circles.clear();
    const marginCells = 2;
    const cellsMinX = marginCells;
    const cellsMinY = marginCells;
    const cellsMaxX = Math.max(cellsMinX, gridX - 1 - marginCells);
    const cellsMaxY = Math.max(cellsMinY, gridY - 1 - marginCells);
    if (cellsMaxX < cellsMinX || cellsMaxY < cellsMinY) {
      updateActiveCount();
      markDirty();
      return;
    }
    const count = clamp(Math.round(Number(randomCount) || 1), 1, MAX_RANDOM);
    const diameterList = [];
    if (count === 1) {
			diameterList.push(3);
    } else if (count === 2) {
			diameterList.push(3, 2);
    } else {
			diameterList.push(3, 2, 2);
      for (let i = 3; i < count; i += 1) {
        diameterList.push(1);
      }
    }

    for (const diameter of diameterList) {
      const isOdd = diameter % 2 === 1;
      let placed = false;
      for (let attempt = 0; attempt < 200 && !placed; attempt += 1) {
        const cellX =
          Math.floor(Math.random() * (cellsMaxX - cellsMinX + 1)) + cellsMinX;
        const cellY =
          Math.floor(Math.random() * (cellsMaxY - cellsMinY + 1)) + cellsMinY;
        const xHalf = isOdd ? cellX * 2 + 1 : cellX * 2;
        const yHalf = isOdd ? cellY * 2 + 1 : cellY * 2;
        const centerX = xHalf / 2;
        const centerY = yHalf / 2;
        const radius = diameter / 2;
        const hasMargin =
          centerX - radius >= marginCells &&
          centerY - radius >= marginCells &&
          centerX + radius <= gridX - marginCells &&
          centerY + radius <= gridY - marginCells;
        placed = hasMargin && addCircleAt(xHalf, yHalf, diameter);
      }
    }

    updateActiveCount();
    markDirty();
  }

  function fillMask() {
    circles.clear();
    const diameter = clamp(Math.round(defaultDiameter), 1, MAX_GRID);
    const radius = diameter / 2;
    const parity = diameter % 2;
    for (let yHalf = 0; yHalf <= gridY * 2; yHalf += 1) {
      if (yHalf % 2 !== parity) continue;
      const cy = yHalf / 2;
      if (cy < radius || cy > gridY - radius) continue;
      for (let xHalf = 0; xHalf <= gridX * 2; xHalf += 1) {
        if (xHalf % 2 !== parity) continue;
        const cx = xHalf / 2;
        if (cx < radius || cx > gridX - radius) continue;
        const key = keyFromHalf(xHalf, yHalf);
        circles.set(key, { xHalf, yHalf, diameter });
      }
    }
    updateActiveCount();
    markDirty();
  }

  function getCellFromEvent(event) {
    const rect = canvasEl.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / cellSize);
    const y = Math.floor((event.clientY - rect.top) / cellSize);
    return {
      x: clamp(x, 0, Math.max(0, gridX - 1)),
      y: clamp(y, 0, Math.max(0, gridY - 1)),
    };
  }

  function findCircleAtEvent(event) {
    const rect = canvasEl.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    let hit = null;
    let best = Infinity;
    for (const [key, circle] of circles.entries()) {
      const cx = (circle.xHalf / 2) * cellSize;
      const cy = (circle.yHalf / 2) * cellSize;
      const radiusPx = (circle.diameter / 2) * cellSize;
      const dx = px - cx;
      const dy = py - cy;
      const dist = Math.hypot(dx, dy);
      if (dist <= radiusPx && dist < best) {
        best = dist;
        hit = { key, circle };
      }
    }
    return hit;
  }

  function updateActiveCircleFromBox(startCell, currentCell) {
    const x0 = Math.min(startCell.x, currentCell.x);
    const y0 = Math.min(startCell.y, currentCell.y);
    const x1 = Math.max(startCell.x, currentCell.x) + 1;
    const y1 = Math.max(startCell.y, currentCell.y) + 1;
    const widthCells = Math.max(1, x1 - x0);
    const heightCells = Math.max(1, y1 - y0);
    const diameter = Math.max(1, Math.min(widthCells, heightCells));
    const centerX = x0 + widthCells / 2;
    const centerY = y0 + heightCells / 2;
    const xHalf = Math.round(centerX * 2);
    const yHalf = Math.round(centerY * 2);
    setActiveCircle(xHalf, yHalf, diameter);
  }

  function onCanvasPointerDown(event) {
    if (event.button !== 0) return;
    dragStartCell = getCellFromEvent(event);
    isDragging = true;
    dragMoved = false;
    const hit = findCircleAtEvent(event);
    startedOnCircleKey = hit?.key || null;
    if (!startedOnCircleKey) {
      updateActiveCircleFromBox(dragStartCell, dragStartCell);
    }
    canvasEl.setPointerCapture(event.pointerId);
  }

  function onCanvasPointerMove(event) {
    if (!isDragging) return;
    const currentCell = getCellFromEvent(event);
    if (
      currentCell.x !== dragStartCell.x ||
      currentCell.y !== dragStartCell.y
    ) {
      dragMoved = true;
    }
    if (startedOnCircleKey) {
      if (!dragMoved) return;
      if (!activeCircleKey) activeCircleKey = startedOnCircleKey;
    }
    updateActiveCircleFromBox(dragStartCell, currentCell);
  }

  function onCanvasPointerUp(event) {
    if (!isDragging) return;
    isDragging = false;
    if (startedOnCircleKey && !dragMoved) {
      circles.delete(startedOnCircleKey);
      updateActiveCount();
      markDirty();
    }
    activeCircleKey = null;
    startedOnCircleKey = null;
    canvasEl.releasePointerCapture(event.pointerId);
  }

  function updateMaskCanvas() {
    if (!maskCtx || !maskCanvas) return;
    const width = maskCanvas.width;
    const height = maskCanvas.height;
    maskCtx.clearRect(0, 0, width, height);
    maskCtx.fillStyle = "#000000";
    maskCtx.fillRect(0, 0, width, height);
    maskCtx.fillStyle = "#ffffff";
    const baseW = Math.max(1, canvasWidthPx);
    const baseH = Math.max(1, canvasHeightPx);
    const scaleX = width / baseW;
    const scaleY = height / baseH;
    for (const circle of circles.values()) {
      const radius = (circle.diameter / 2) * cellSize * scaleX;
      const cx = (circle.xHalf / 2) * cellSize * scaleX;
      const cy = (circle.yHalf / 2) * cellSize * scaleY;
      maskCtx.beginPath();
      maskCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      maskCtx.fill();
    }
    if (maskTexture) maskTexture.needsUpdate = true;
  }

  function render() {
    if (!renderer) return;
    const width = internalWidth;
    const height = internalHeight;
    updateMaskCanvas();
    const iterations = clamp(Math.round(blurIterations), 1, MAX_ITER);
    const radiusPx = clamp(blurRadius, 0, MAX_BLUR);

    let inputTex = maskTexture;
    for (let i = 0; i < iterations; i += 1) {
      blurMaterial.uniforms.uInput.value = inputTex;
      blurMaterial.uniforms.uDirection.value.set(1, 0);
      blurMaterial.uniforms.uResolution.value.set(width, height);
      blurMaterial.uniforms.uRadius.value = radiusPx;
      quad.material = blurMaterial;
      renderer.setRenderTarget(rtA);
      renderer.render(scene, camera);

      blurMaterial.uniforms.uInput.value = rtA.texture;
      blurMaterial.uniforms.uDirection.value.set(0, 1);
      quad.material = blurMaterial;
      renderer.setRenderTarget(rtB);
      renderer.render(scene, camera);

      inputTex = rtB.texture;
    }

    finalMaterial.uniforms.uInput.value = inputTex;
    quad.material = finalMaterial;
    renderer.setRenderTarget(null);
    renderer.render(scene, camera);
  }

  function markDirty() {
    if (!renderer) return;
    if (!needsRender) {
      needsRender = true;
      rafId = requestAnimationFrame(() => {
        needsRender = false;
        render();
      });
    }
  }

  function setupRenderer(width, height) {
    const scale = getEffectiveRenderScale(width, height);
    const scaledWidth = Math.max(1, Math.floor(width * scale));
    const scaledHeight = Math.max(1, Math.floor(height * scale));
    internalWidth = scaledWidth;
    internalHeight = scaledHeight;

    maskCanvas = document.createElement("canvas");
    maskCanvas.width = scaledWidth;
    maskCanvas.height = scaledHeight;
    maskCtx = maskCanvas.getContext("2d");

    maskTexture = new THREE.CanvasTexture(maskCanvas);
    maskTexture.minFilter = THREE.LinearFilter;
    maskTexture.magFilter = THREE.LinearFilter;
    maskTexture.wrapS = THREE.ClampToEdgeWrapping;
    maskTexture.wrapT = THREE.ClampToEdgeWrapping;

    rtA = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
    });
    rtB = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
    });

    scene = new THREE.Scene();
    camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    blurMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: blurFragment,
      uniforms: {
        uInput: { value: maskTexture },
        uResolution: { value: new THREE.Vector2(scaledWidth, scaledHeight) },
        uDirection: { value: new THREE.Vector2(1, 0) },
        uRadius: { value: blurRadius },
      },
    });

    finalMaterial = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: finalFragment,
      uniforms: {
        uInput: { value: maskTexture },
        uThreshold: { value: 0.5 },
      },
    });

    quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), finalMaterial);
    scene.add(quad);
  }

  function rebuildRenderTargets(width, height) {
    const scale = getEffectiveRenderScale(width, height);
    const scaledWidth = Math.max(1, Math.floor(width * scale));
    const scaledHeight = Math.max(1, Math.floor(height * scale));
    internalWidth = scaledWidth;
    internalHeight = scaledHeight;

    maskCanvas = document.createElement("canvas");
    maskCanvas.width = scaledWidth;
    maskCanvas.height = scaledHeight;
    maskCtx = maskCanvas.getContext("2d");

    maskTexture?.dispose();
    maskTexture = new THREE.CanvasTexture(maskCanvas);
    maskTexture.minFilter = THREE.LinearFilter;
    maskTexture.magFilter = THREE.LinearFilter;
    maskTexture.wrapS = THREE.ClampToEdgeWrapping;
    maskTexture.wrapT = THREE.ClampToEdgeWrapping;

    rtA?.dispose();
    rtB?.dispose();
    rtA = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
    });
    rtB = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      type: THREE.UnsignedByteType,
    });

    if (blurMaterial) {
      blurMaterial.uniforms.uInput.value = maskTexture;
      blurMaterial.uniforms.uResolution.value.set(scaledWidth, scaledHeight);
    }
    if (finalMaterial) {
      finalMaterial.uniforms.uInput.value = maskTexture;
    }
  }

  function resizeRenderer(width, height) {
    if (!renderer) return;
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const safeWidth = Math.max(1, Math.round(width));
    const safeHeight = Math.max(1, Math.round(height));
    renderer.setSize(safeWidth, safeHeight, true);
    const scale = getEffectiveRenderScale(safeWidth, safeHeight);
    const scaledWidth = Math.max(1, Math.floor(safeWidth * scale));
    const scaledHeight = Math.max(1, Math.floor(safeHeight * scale));
    internalWidth = scaledWidth;
    internalHeight = scaledHeight;
    maskCanvas.width = scaledWidth;
    maskCanvas.height = scaledHeight;
    maskTexture.needsUpdate = true;
    rtA.setSize(scaledWidth, scaledHeight);
    rtB.setSize(scaledWidth, scaledHeight);
    blurMaterial.uniforms.uResolution.value.set(scaledWidth, scaledHeight);
    markDirty();
  }

  onMount(() => {
    renderer = new THREE.WebGLRenderer({
      canvas: canvasEl,
      antialias: true,
      alpha: true,
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0xffffff, 0);

    updateGridCounts();
    const { width, height } = getCanvasSizePx();
    setupRenderer(width, height);
    resizeRenderer(width, height);

    randomizeCircles();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      renderer?.dispose();
      rtA?.dispose();
      rtB?.dispose();
      blurMaterial?.dispose();
      finalMaterial?.dispose();
      quad?.geometry?.dispose();
    };
  });

  $: if (containerEl && renderer) {
    cellSize;
    gridWidthUnits;
    gridHeightUnits;
    defaultDiameter;
    randomCount;
    blurRadius;
    blurIterations;
    renderScale;
    showGrid;
    updateGridCounts();
    updateActiveCount();
    const { width, height } = getCanvasSizePx();
    const gridKey = `${gridX}x${gridY}`;
    if (gridKey !== lastGridKey) {
      lastGridKey = gridKey;
      rebuildRenderTargets(width, height);
      resizeRenderer(width, height);
      randomizeCircles();
    } else {
      resizeRenderer(width, height);
    }
    markDirty();
  }

  $: if (renderer) {
    const count = clamp(Math.round(Number(randomCount) || 1), 1, MAX_RANDOM);
    if (count !== randomCount) {
      randomCount = count;
    }
    if (count !== lastRandomCount) {
      lastRandomCount = count;
      randomizeCircles();
    }
  }
</script>

<svelte:head>
  <title>Metaballz!</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link
    href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap"
    rel="stylesheet"
  />
</svelte:head>

<main class="page">
  <section class="panel">
    <div class="panel__header">
      <h1>Metaballz!</h1>
      <p>Drag from a corner to size; click a circle to erase.</p>
    </div>

    <div class="controls">
      <label>
        <span>Grid cell size (px)</span>
        <div class="input-row">
          <input
            type="range"
            min="20"
            max="200"
            step="10"
            bind:value={cellSize}
          />
          <input
            class="number"
            type="number"
            min="20"
            max="200"
            step="10"
            bind:value={cellSize}
          />
        </div>
        <strong>{cellSize}px</strong>
      </label>

      <label>
        <span>Grid size (units)</span>
        <div class="input-row">
          <input
            class="number"
            type="number"
            min="2"
            max={MAX_GRID}
            step="1"
            bind:value={gridWidthUnits}
          />
          <span class="unit">×</span>
          <input
            class="number"
            type="number"
            min="2"
            max={MAX_GRID}
            step="1"
            bind:value={gridHeightUnits}
          />
        </div>
        <strong>{gridX} × {gridY} units</strong>
      </label>

      <label>
        <span>New circle diameter (grid units)</span>
        <div class="input-row">
          <input
            type="range"
            min="1"
            max="12"
            step="1"
            bind:value={defaultDiameter}
          />
          <input
            class="number"
            type="number"
            min="1"
            max="12"
            step="1"
            bind:value={defaultDiameter}
          />
        </div>
        <strong>{defaultDiameter} units</strong>
      </label>

      <label>
        <span>Random circles</span>
        <div class="input-row">
          <input
            type="range"
            min="1"
            max={MAX_RANDOM}
            step="1"
            bind:value={randomCount}
          />
          <input
            class="number"
            type="number"
            min="1"
            max={MAX_RANDOM}
            step="1"
            bind:value={randomCount}
          />
        </div>
        <strong>{randomCount} circles</strong>
      </label>

      <label>
        <span>Blur radius (px)</span>
        <div class="input-row">
          <input
            type="range"
            min="0"
            max={MAX_BLUR}
            step="1"
            bind:value={blurRadius}
          />
          <input
            class="number"
            type="number"
            min="0"
            max={MAX_BLUR}
            step="1"
            bind:value={blurRadius}
          />
        </div>
        <strong>{blurRadius}px</strong>
      </label>

      <label>
        <span>Blur iterations</span>
        <div class="input-row">
          <input
            type="range"
            min="1"
            max={MAX_ITER}
            step="1"
            bind:value={blurIterations}
          />
          <input
            class="number"
            type="number"
            min="1"
            max={MAX_ITER}
            step="1"
            bind:value={blurIterations}
          />
        </div>
        <strong>{blurIterations} passes</strong>
      </label>

      <label>
        <span>Quality scale</span>
        <div class="input-row">
          <input
            type="range"
            min="0.5"
            max="1.5"
            step="0.05"
            bind:value={renderScale}
          />
          <input
            class="number"
            type="number"
            min="0.5"
            max="1.5"
            step="0.05"
            bind:value={renderScale}
          />
        </div>
        <strong>{renderScale.toFixed(2)}×</strong>
      </label>

      <label class="toggle">
        <input type="checkbox" bind:checked={showGrid} />
        <span>Show grid</span>
      </label>
    </div>

    <div class="stats">
      <span>Grid: {gridX} × {gridY}</span>
      <span>Circles: {activeCount}</span>
    </div>

    <div class="actions">
      <button type="button" on:click={exportPng}>Export PNG</button>
      <button type="button" on:click={exportSvg} class="ghost"
        >Export SVG</button
      >
      <button type="button" on:click={randomizeCircles} class="ghost"
        >Randomize</button
      >
      <button type="button" on:click={clearMask} class="ghost"
        >Clear grid</button
      >
    </div>
  </section>

  <section
    class="canvas-wrap"
    class:show-grid={showGrid}
    bind:this={containerEl}
    style={`--cell:${cellSize}px; --canvas-w:${canvasWidthPx}px; --canvas-h:${canvasHeightPx}px;`}
  >
    <canvas
      bind:this={canvasEl}
      class="canvas"
      on:pointerdown={onCanvasPointerDown}
      on:pointermove={onCanvasPointerMove}
      on:pointerup={onCanvasPointerUp}
    ></canvas>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: "Space Grotesk", system-ui, sans-serif;
    background: #f5f6f7;
    color: #111111;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .page {
    min-height: 100vh;
    display: grid;
    grid-template-columns: minmax(260px, 340px) 1fr;
    gap: 24px;
    padding: 32px;
  }

  .panel {
    display: flex;
    flex-direction: column;
    gap: 24px;
    padding: 24px;
    border-radius: 20px;
    background: #ffffff;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
  }

  .panel__header h1 {
    margin: 0 0 8px;
    font-size: 1.8rem;
    letter-spacing: 0.02em;
  }

  .panel__header p {
    margin: 0;
    color: #3b3b3b;
  }

  .controls {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 0.95rem;
  }

  label span {
    color: #2b2b2b;
  }

  label strong {
    font-weight: 600;
    color: #111111;
  }

  input[type="range"] {
    width: 100%;
    accent-color: #111111;
  }

  .input-row {
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .input-row .number {
    width: 72px;
    padding: 6px 8px;
    border-radius: 10px;
    border: 1px solid rgba(0, 0, 0, 0.2);
    font: inherit;
    color: #111111;
    background: #ffffff;
  }

  .input-row .unit {
    font-weight: 600;
    color: #2b2b2b;
  }

  .toggle {
    flex-direction: row;
    align-items: center;
    gap: 12px;
    font-weight: 600;
    color: #2b2b2b;
  }

  .stats {
    display: flex;
    justify-content: space-between;
    font-size: 0.9rem;
    color: #3b3b3b;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .actions button {
    border: none;
    border-radius: 999px;
    padding: 10px 18px;
    background: #111111;
    color: #ffffff;
    font-weight: 700;
    cursor: pointer;
    transition:
      transform 0.2s ease,
      box-shadow 0.2s ease;
  }

  .actions button.ghost {
    background: transparent;
    color: #111111;
    border: 1px solid rgba(0, 0, 0, 0.2);
  }

  .actions button:hover {
    transform: translateY(-1px);
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.18);
  }

  .canvas-wrap {
    position: relative;
    width: var(--canvas-w);
    height: var(--canvas-h);
    justify-self: start;
    align-self: start;
    border-radius: 24px;
    overflow: hidden;
    background: #ffffff;
    box-shadow:
      inset 0 0 0 1px rgba(0, 0, 0, 0.08),
      0 20px 50px rgba(0, 0, 0, 0.1);
    --grid-line: rgba(0, 0, 0, 0.08);
    background-image: linear-gradient(
        to right,
        var(--grid-line) 1px,
        transparent 1px
      ),
      linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px);
    background-size: var(--cell) var(--cell);
    background-position: 0 0;
  }

  .canvas-wrap:not(.show-grid) {
    background-image: none;
  }

  .canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: crosshair;
    background: transparent;
  }

  @media (max-width: 900px) {
    .page {
      grid-template-columns: 1fr;
    }

    .panel {
      order: 2;
    }

    .canvas-wrap {
      min-height: 320px;
    }
  }
</style>
