<script>
  import { onMount } from "svelte";
  import * as THREE from "three";
  import "$lib/styles/metaballs-shared.css";
  import "$lib/styles/metaballs-pages.css";
  import {
    MAX_GRID,
    MAX_RANDOM,
    MAX_BLUR,
    MAX_ITER,
  } from "$lib/metaballs/constants.js";
  import {
    clamp,
    sanitizeGridUnits,
    sanitizeCellSize,
    getEffectiveRenderScale,
    keyFromHalf,
    isValidCenterHalf,
    buildDiameterList,
    buildExportFilename,
  } from "$lib/metaballs/utils.js";
  import { traceContours } from "$lib/metaballs/contours.js";

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
  let mirrorXAxis = false;
  let mirrorYAxis = false;
  let preserveHoles = true;
  let maskDataUrl = "";

  let gridX = 0;
  let gridY = 0;
  let activeCount = 0;
  let canvasWidthPx = 0;
  let canvasHeightPx = 0;
  let lastGridKey = "";

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

  function getCanvasSizePx() {
    return {
      width: canvasWidthPx,
      height: canvasHeightPx,
    };
  }

  function getRenderScale() {
    return clamp(Number(renderScale) || 1, 0.5, 1.5);
  }

  function addCircleAt(xHalf, yHalf, diameter) {
    if (!isValidCenterHalf(xHalf, yHalf, diameter, gridX, gridY)) return false;
    const key = keyFromHalf(xHalf, yHalf);
    if (circles.has(key)) return false;
    circles.set(key, { xHalf, yHalf, diameter });
    return true;
  }

  function updateActiveCount() {
    activeCount = circles.size;
  }

  function setActiveCircle(xHalf, yHalf, diameter) {
    const snapped = clamp(Math.round(diameter), 1, MAX_GRID);
    if (!isValidCenterHalf(xHalf, yHalf, snapped, gridX, gridY)) return;
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
    link.download = buildExportFilename("editor", gridX, gridY, "png");
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
    const pathMarkup = preserveHoles
      ? `  <path d="${pathData}" fill="black" stroke="none" fill-rule="evenodd"/>\n`
      : paths
          .map((poly) => {
            const d = poly
              .map((pt, idx) => {
                const x = (pt.x * scaleX).toFixed(2);
                const y = ((height - pt.y) * scaleY).toFixed(2);
                return `${idx === 0 ? "M" : "L"} ${x} ${y}`;
              })
              .join(" ");
            return `  <path d="${d} Z" fill="black" stroke="none"/>`;
          })
          .join("\n");
    const svg =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${outW}" height="${outH}" viewBox="0 0 ${outW} ${outH}">\n` +
      `  <rect width="100%" height="100%" fill="white"/>\n` +
      `${pathMarkup}` +
      `</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = buildExportFilename("editor", gridX, gridY, "svg");
    link.click();
    URL.revokeObjectURL(link.href);
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
    const diameterList = buildDiameterList(count);

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
    const drawCircle = (xHalf, yHalf, diameter) => {
      const radius = (diameter / 2) * cellSize * scaleX;
      const cx = (xHalf / 2) * cellSize * scaleX;
      const cy = (yHalf / 2) * cellSize * scaleY;
      maskCtx.beginPath();
      maskCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      maskCtx.fill();
    };
    for (const circle of circles.values()) {
      const mirroredXHalf = gridX * 2 - circle.xHalf;
      const mirroredYHalf = gridY * 2 - circle.yHalf;
      const xCandidates = mirrorXAxis && mirroredXHalf !== circle.xHalf
        ? [circle.xHalf, mirroredXHalf]
        : [circle.xHalf];
      const yCandidates = mirrorYAxis && mirroredYHalf !== circle.yHalf
        ? [circle.yHalf, mirroredYHalf]
        : [circle.yHalf];
      for (const xHalf of xCandidates) {
        for (const yHalf of yCandidates) {
          drawCircle(xHalf, yHalf, circle.diameter);
        }
      }
    }
    if (maskTexture) maskTexture.needsUpdate = true;
  }

  function contoursToMaskDataUrl(paths, sourceWidth, sourceHeight, outputWidth, outputHeight, keepHoles) {
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    const scaleX = outputWidth / sourceWidth;
    const scaleY = outputHeight / sourceHeight;
    ctx.clearRect(0, 0, outputWidth, outputHeight);
    ctx.fillStyle = "#ffffff";

    if (keepHoles) {
      const path = new Path2D();
      for (const poly of paths) {
        if (!poly.length) continue;
        path.moveTo(poly[0].x * scaleX, (sourceHeight - poly[0].y) * scaleY);
        for (let i = 1; i < poly.length; i += 1) {
          path.lineTo(poly[i].x * scaleX, (sourceHeight - poly[i].y) * scaleY);
        }
        path.closePath();
      }
      ctx.fill(path, "evenodd");
      return canvas.toDataURL("image/png");
    }

    for (const poly of paths) {
      if (!poly.length) continue;
      ctx.beginPath();
      ctx.moveTo(poly[0].x * scaleX, (sourceHeight - poly[0].y) * scaleY);
      for (let i = 1; i < poly.length; i += 1) {
        ctx.lineTo(poly[i].x * scaleX, (sourceHeight - poly[i].y) * scaleY);
      }
      ctx.closePath();
      ctx.fill();
    }
    return canvas.toDataURL("image/png");
  }

  function updatePreviewMask() {
    if (!renderer || !rtB) return;
    const width = internalWidth;
    const height = internalHeight;
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(rtB, 0, 0, width, height, pixels);
    const paths = traceContours(pixels, width, height, 128);
    maskDataUrl = contoursToMaskDataUrl(
      paths,
      width,
      height,
      Math.max(1, canvasWidthPx),
      Math.max(1, canvasHeightPx),
      preserveHoles,
    );
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
    updatePreviewMask();
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
    const scale = getEffectiveRenderScale(width, height, getRenderScale());
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
    const scale = getEffectiveRenderScale(width, height, getRenderScale());
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
    const scale = getEffectiveRenderScale(
      safeWidth,
      safeHeight,
      getRenderScale(),
    );
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
    mirrorXAxis;
    mirrorYAxis;
    preserveHoles;
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

<main class="page metaballs-page editor-page">
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
            max="4.0"
            step="0.05"
            bind:value={renderScale}
          />
          <input
            class="number"
            type="number"
            min="0.5"
            max="4.0"
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

      <label class="toggle">
        <input type="checkbox" bind:checked={mirrorXAxis} />
        <span>Mirror X axis</span>
      </label>

      <label class="toggle">
        <input type="checkbox" bind:checked={mirrorYAxis} />
        <span>Mirror Y axis</span>
      </label>

      <label class="toggle">
        <input type="checkbox" bind:checked={preserveHoles} />
        <span>Preserve holes</span>
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
    style={`--cell:${cellSize}px; --canvas-w:${canvasWidthPx}px; --canvas-h:${canvasHeightPx}px; --mask-url:${maskDataUrl ? `url('${maskDataUrl}')` : "none"};`}
  >
    <div class="preview-layer"></div>
    <canvas
      bind:this={canvasEl}
      class="canvas"
      on:pointerdown={onCanvasPointerDown}
      on:pointermove={onCanvasPointerMove}
      on:pointerup={onCanvasPointerUp}
    ></canvas>
  </section>
</main>

