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
    keyFromHalf,
    isValidCenterHalf,
    clampRenderScale,
    resolveGridState,
    getCellFromPointerEvent,
    findCircleAtPointerEvent,
    getCircleFromCellBox,
    computeCanvasFit,
    contoursToMaskDataUrl,
    getCanvasSizePx as getCanvasSizeMetrics,
    tryAddCircleAt,
    buildRandomCircleMap,
    populateFilledCircleMap,
    handleCanvasPointerDown,
    handleCanvasPointerMove,
    handleCanvasPointerUp,
    scheduleDirtyRender,
    setupRendererResources,
    rebuildRendererResources,
    resizeRendererResources,
  } from "$lib/metaballs/utils.js";
  import { traceContours } from "$lib/metaballs/contours.js";
  import { exportEditorPng, exportEditorSvg } from "./exports.js";

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
  let canvasScale = 1;
  let canvasDisplayWidthPx = 1;
  let canvasDisplayHeightPx = 1;
  let canvasScaleObserver;

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
    const next = resolveGridState(gridWidthUnits, gridHeightUnits, gridX || 10, gridY || 10, 100);
    cellSize = next.cellSize;
    gridX = next.gridX;
    gridY = next.gridY;
    gridWidthUnits = next.gridWidthUnits;
    gridHeightUnits = next.gridHeightUnits;
    canvasWidthPx = next.canvasWidthPx;
    canvasHeightPx = next.canvasHeightPx;
  }

  function getCanvasSizePx() {
    return getCanvasSizeMetrics(canvasWidthPx, canvasHeightPx);
  }

  function getRenderScale() {
    return clampRenderScale(renderScale);
  }

  function addCircleAt(xHalf, yHalf, diameter) {
    return tryAddCircleAt(circles, xHalf, yHalf, diameter, gridX, gridY);
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
    exportEditorPng({ renderer, render, gridX, gridY });
  }

  function exportSvg() {
    const { width: outW, height: outH } = getCanvasSizePx();
    exportEditorSvg({
      renderer,
      rtB,
      render,
      internalWidth,
      internalHeight,
      outputWidth: outW,
      outputHeight: outH,
      preserveHoles,
      gridX,
      gridY,
    });
  }

  function randomizeCircles() {
    circles.clear();
    const nextCircles = buildRandomCircleMap({
      sourceGridX: gridX,
      sourceGridY: gridY,
      randomCount,
      maxRandom: MAX_RANDOM,
      marginCells: 2,
    });
    for (const [key, value] of nextCircles.entries()) {
      circles.set(key, value);
    }

    updateActiveCount();
    markDirty();
  }

  function fillMask() {
    populateFilledCircleMap(circles, defaultDiameter, gridX, gridY);
    updateActiveCount();
    markDirty();
  }

  function getCellFromEvent(event) {
    return getCellFromPointerEvent(event, canvasEl, gridX, gridY);
  }

  function findCircleAtEvent(event) {
    return findCircleAtPointerEvent(event, canvasEl, circles, gridX, gridY);
  }

  function updateActiveCircleFromBox(startCell, currentCell) {
    const { xHalf, yHalf, diameter } = getCircleFromCellBox(startCell, currentCell);
    setActiveCircle(xHalf, yHalf, diameter);
  }

  function onCanvasPointerDown(event) {
    const next = handleCanvasPointerDown(
      event,
      canvasEl,
      getCellFromEvent,
      findCircleAtEvent,
      updateActiveCircleFromBox,
    );
    if (!next.handled) return;
    dragStartCell = next.dragStartCell;
    isDragging = next.isDragging;
    dragMoved = next.dragMoved;
    startedOnCircleKey = next.startedOnCircleKey;
  }

  function onCanvasPointerMove(event) {
    const next = handleCanvasPointerMove(
      event,
      { isDragging, dragStartCell, dragMoved, startedOnCircleKey, activeCircleKey },
      getCellFromEvent,
      updateActiveCircleFromBox,
    );
    if (!next.handled) return;
    dragMoved = next.dragMoved;
    activeCircleKey = next.activeCircleKey;
  }

  function onCanvasPointerUp(event) {
    const next = handleCanvasPointerUp(event, canvasEl, { isDragging });
    if (!next.handled) return;
    isDragging = next.isDragging;
    if (startedOnCircleKey && !dragMoved) {
      circles.delete(startedOnCircleKey);
      updateActiveCount();
      markDirty();
    }
    activeCircleKey = next.activeCircleKey;
    startedOnCircleKey = next.startedOnCircleKey;
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
    const next = scheduleDirtyRender(renderer, needsRender, () => {
      needsRender = false;
      render();
    });
    needsRender = next.needsRender;
    if (next.rafId !== undefined) rafId = next.rafId;
  }

  function setupRenderer(width, height) {
    const next = setupRendererResources({
      width,
      height,
      baseRenderScale: getRenderScale(),
      blurRadius,
      vertexShader,
      blurFragment,
      finalFragment,
    });
    internalWidth = next.internalWidth;
    internalHeight = next.internalHeight;
    maskCanvas = next.maskCanvas;
    maskCtx = next.maskCtx;
    maskTexture = next.maskTexture;
    rtA = next.rtA;
    rtB = next.rtB;
    scene = next.scene;
    camera = next.camera;
    blurMaterial = next.blurMaterial;
    finalMaterial = next.finalMaterial;
    quad = next.quad;
  }

  function rebuildRenderTargets(width, height) {
    const next = rebuildRendererResources({
      width,
      height,
      baseRenderScale: getRenderScale(),
      maskTexture,
      rtA,
      rtB,
      blurMaterial,
      finalMaterial,
    });
    internalWidth = next.internalWidth;
    internalHeight = next.internalHeight;
    maskCanvas = next.maskCanvas;
    maskCtx = next.maskCtx;
    maskTexture = next.maskTexture;
    rtA = next.rtA;
    rtB = next.rtB;
  }

  function resizeRenderer(width, height) {
    const next = resizeRendererResources({
      renderer,
      width,
      height,
      baseRenderScale: getRenderScale(),
      maskCanvas,
      maskTexture,
      rtA,
      rtB,
      blurMaterial,
    });
    if (!next) return;
    internalWidth = next.internalWidth;
    internalHeight = next.internalHeight;
    markDirty();
  }

  function updateCanvasScale() {
    const fit = computeCanvasFit(containerEl, canvasWidthPx, canvasHeightPx);
    canvasScale = fit.canvasScale;
    canvasDisplayWidthPx = fit.canvasDisplayWidthPx;
    canvasDisplayHeightPx = fit.canvasDisplayHeightPx;
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
    updateCanvasScale();
    canvasScaleObserver = new ResizeObserver(() => {
      updateCanvasScale();
    });
    canvasScaleObserver.observe(containerEl);
    window.addEventListener("resize", updateCanvasScale);

    return () => {
      canvasScaleObserver?.disconnect();
      window.removeEventListener("resize", updateCanvasScale);
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
    updateCanvasScale();
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
    <div class="controls">
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
    style={`--cell:${cellSize}px; --canvas-w:${canvasWidthPx}px; --canvas-h:${canvasHeightPx}px; --canvas-scale:${canvasScale}; --canvas-display-w:${canvasDisplayWidthPx}px; --canvas-display-h:${canvasDisplayHeightPx}px; --mask-url:${maskDataUrl ? `url('${maskDataUrl}')` : "none"};`}
  >
    <div class="canvas-stage">
      <div class="preview-layer"></div>
      <canvas
        bind:this={canvasEl}
        class="canvas"
        on:pointerdown={onCanvasPointerDown}
        on:pointermove={onCanvasPointerMove}
        on:pointerup={onCanvasPointerUp}
      ></canvas>
    </div>
  </section>
</main>

