<script>
  import { onMount } from "svelte";
  import * as THREE from "three";
  import "$lib/styles/metaballs-shared.css";
  import "$lib/styles/metaballs-pages.css";
  import { MAX_GRID, MAX_RANDOM, MAX_BLUR, MAX_ITER } from "$lib/metaballs/constants.js";
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
  import { exportPatternPng, exportPatternSvg } from "./exports.js";

  let containerEl;
  let canvasEl;

  let cellSize = 100;
  let gridWidthUnits = 16;
  let gridHeightUnits = 10;
  let defaultDiameter = 1;
  let randomCount = 27;
  let blurRadius = 3;
  let blurIterations = 15;
  let showGrid = true;
  let mirrorXAxis = false;
  let mirrorYAxis = false;
  let preserveHoles = true;

  let gridX = 0;
  let gridY = 0;
  let previousGridX = 0;
  let previousGridY = 0;
  let activeCount = 0;
  let canvasWidthPx = 0;
  let canvasHeightPx = 0;
  let lastGridKey = "";

  const MAX_LAYERS = 8;
  const circles = new Map();
  let layers = [];
  let layerId = 0;
  let displayLayers = [];

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

  function addCircleAt(xHalf, yHalf, diameter, targetCircles = circles, sourceGridX = gridX, sourceGridY = gridY) {
    return tryAddCircleAt(targetCircles, xHalf, yHalf, diameter, sourceGridX, sourceGridY);
  }

  function updateActiveCount() {
    activeCount = layers.reduce((sum, layer) => sum + layer.circles.size, 0);
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
    layers = layers.map((layer) => ({ ...layer, circles: new Map() }));
    updateActiveCount();
    markDirty();
  }

  function randomLayerColor() {
    const channel = () =>
      Math.floor(60 + Math.random() * 180)
        .toString(16)
        .padStart(2, "0");
    return `#${channel()}${channel()}${channel()}`;
  }

  function createLayer(offsetFromDisplayTop) {
    layerId += 1;
    const layerGridWidth = clamp(gridX + offsetFromDisplayTop, 1, MAX_GRID);
    const layerGridHeight = clamp(gridY + offsetFromDisplayTop, 1, MAX_GRID);
    return {
      id: layerId,
      color: randomLayerColor(),
      gridWidthUnits: layerGridWidth,
      gridHeightUnits: layerGridHeight,
      circles: createRandomCircleMap(layerGridWidth, layerGridHeight),
      maskDataUrl: "",
    };
  }

  function initializeLayers(count = 3) {
    const safeCount = clamp(Math.round(count), 1, MAX_LAYERS);
    layers = Array.from({ length: safeCount }, (_, index) =>
      createLayer(safeCount - 1 - index),
    );
    updateActiveCount();
    markDirty();
  }

  function addLayer() {
    if (layers.length >= MAX_LAYERS) return;
    layers = [...layers, createLayer(0)];
    updateActiveCount();
    markDirty();
  }

  function removeLayerById(id) {
    if (layers.length <= 1) return;
    layers = layers.filter((layer) => layer.id !== id);
    updateActiveCount();
    markDirty();
  }

  function updateLayerColor(id, color) {
    layers = layers.map((layer) => (layer.id === id ? { ...layer, color } : layer));
  }

  function updateLayerGrid(id, axis, value) {
    const parsed = Number(value);
    const nextValue = Number.isFinite(parsed) ? clamp(Math.round(parsed), 1, MAX_GRID) : 1;
    layers = layers.map((layer) => {
      if (layer.id !== id) return layer;
      const nextLayer = { ...layer, [axis]: nextValue };
      return {
        ...nextLayer,
        circles: createRandomCircleMap(nextLayer.gridWidthUnits, nextLayer.gridHeightUnits),
      };
    });
    updateActiveCount();
    markDirty();
  }

  function applyMainGridDeltaToLayers(deltaX, deltaY) {
    if (!deltaX && !deltaY) return;
    layers = layers.map((layer) => ({
      ...layer,
      gridWidthUnits: clamp(layer.gridWidthUnits + deltaX, 1, MAX_GRID),
      gridHeightUnits: clamp(layer.gridHeightUnits + deltaY, 1, MAX_GRID),
    }));
  }

  function moveLayer(id, direction) {
    const index = layers.findIndex((layer) => layer.id === id);
    if (index === -1) return;
    const target = index + direction;
    if (target < 0 || target >= layers.length) return;
    const next = [...layers];
    const [layer] = next.splice(index, 1);
    next.splice(target, 0, layer);
    layers = next;
    markDirty();
  }

  function randomizeLayerColors() {
    layers = layers.map((layer) => ({ ...layer, color: randomLayerColor() }));
  }

  function randomizeLayerMetaballs(id) {
    layers = layers.map((layer) =>
      layer.id === id
        ? {
            ...layer,
            circles: createRandomCircleMap(layer.gridWidthUnits, layer.gridHeightUnits),
          }
        : layer,
    );
    updateActiveCount();
    markDirty();
  }

  function randomizeAllLayers() {
    layers = layers.map((layer) => ({
      ...layer,
      circles: createRandomCircleMap(layer.gridWidthUnits, layer.gridHeightUnits),
    }));
    updateActiveCount();
    markDirty();
  }

  function exportPng() {
    const { width, height } = getCanvasSizePx();
    exportPatternPng({
      renderer,
      render,
      layers,
      outputWidth: width,
      outputHeight: height,
      gridX,
      gridY,
    });
  }

  function exportSvg() {
    const { width: outW, height: outH } = getCanvasSizePx();
    exportPatternSvg({
      renderer,
      rtB,
      render,
      layers,
      internalWidth,
      internalHeight,
      outputWidth: outW,
      outputHeight: outH,
      preserveHoles,
      gridX,
      gridY,
    });
  }

  function createRandomCircleMap(sourceGridX = gridX, sourceGridY = gridY) {
    return buildRandomCircleMap({
      sourceGridX,
      sourceGridY,
      randomCount,
      maxRandom: MAX_RANDOM,
      marginCells: 2,
    });
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

  function updateMaskCanvas(sourceCircles = circles, sourceGridX = gridX, sourceGridY = gridY) {
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
    const originX = ((gridX - sourceGridX) * cellSize) / 2;
    const originY = ((gridY - sourceGridY) * cellSize) / 2;
    const drawCircle = (xHalf, yHalf, diameter) => {
      const radius = (diameter / 2) * cellSize * scaleX;
      const cx = (originX + (xHalf / 2) * cellSize) * scaleX;
      const cy = (originY + (yHalf / 2) * cellSize) * scaleY;
      maskCtx.beginPath();
      maskCtx.arc(cx, cy, radius, 0, Math.PI * 2);
      maskCtx.fill();
    };
    for (const circle of sourceCircles.values()) {
      const mirroredXHalf = sourceGridX * 2 - circle.xHalf;
      const mirroredYHalf = sourceGridY * 2 - circle.yHalf;
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

  function render(sourceCircles = circles, sourceGridX = gridX, sourceGridY = gridY) {
    if (!renderer) return;
    const width = internalWidth;
    const height = internalHeight;
    updateMaskCanvas(sourceCircles, sourceGridX, sourceGridY);
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
    return renderer.domElement.toDataURL("image/png");
  }

  function renderAllLayerMasks() {
    if (!renderer) return;
    const width = internalWidth;
    const height = internalHeight;
    const pixels = new Uint8Array(width * height * 4);
    const { width: outW, height: outH } = getCanvasSizePx();
    layers = layers.map((layer) => ({
      ...layer,
      maskDataUrl: (() => {
        render(layer.circles, layer.gridWidthUnits, layer.gridHeightUnits);
        renderer.readRenderTargetPixels(rtB, 0, 0, width, height, pixels);
        const paths = traceContours(pixels, width, height, 128);
        return contoursToMaskDataUrl(paths, width, height, outW, outH, preserveHoles);
      })(),
    }));
  }

  function markDirty() {
    const next = scheduleDirtyRender(renderer, needsRender, () => {
      needsRender = false;
      renderAllLayerMasks();
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
    previousGridX = gridX;
    previousGridY = gridY;
    const { width, height } = getCanvasSizePx();
    setupRenderer(width, height);
    resizeRenderer(width, height);
    initializeLayers(3);
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
      const deltaX = gridX - previousGridX;
      const deltaY = gridY - previousGridY;
      applyMainGridDeltaToLayers(deltaX, deltaY);
      previousGridX = gridX;
      previousGridY = gridY;
      lastGridKey = gridKey;
      rebuildRenderTargets(width, height);
      resizeRenderer(width, height);
      randomizeAllLayers();
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
      randomizeAllLayers();
    }
  }

  $: displayLayers = [...layers].reverse();
</script>

<svelte:head>
  <title>Metaballz!</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&display=swap" rel="stylesheet" />
</svelte:head>

<main class="page metaballs-page pattern-page">
  <section class="panel">

    <div class="controls">
      <label>
        <span>Grid size (units)</span>
        <div class="input-row">
          <input class="number" type="number" min="2" max={MAX_GRID} step="1" bind:value={gridWidthUnits} />
          <span class="unit">×</span>
          <input class="number" type="number" min="2" max={MAX_GRID} step="1" bind:value={gridHeightUnits} />
        </div>
        <strong>{gridX} × {gridY} units</strong>
      </label>

      <label>
        <span>Random circles</span>
        <div class="input-row">
          <input type="range" min="1" max={MAX_RANDOM} step="1" bind:value={randomCount} />
          <input class="number" type="number" min="1" max={MAX_RANDOM} step="1" bind:value={randomCount} />
        </div>
        <strong>{randomCount} circles</strong>
      </label>

      <label>
        <span>Blur radius (px)</span>
        <div class="input-row">
          <input type="range" min="0" max={MAX_BLUR} step="1" bind:value={blurRadius} />
          <input class="number" type="number" min="0" max={MAX_BLUR} step="1" bind:value={blurRadius} />
        </div>
        <strong>{blurRadius}px</strong>
      </label>

      <label>
        <span>Blur iterations</span>
        <div class="input-row">
          <input type="range" min="1" max={MAX_ITER} step="1" bind:value={blurIterations} />
          <input class="number" type="number" min="1" max={MAX_ITER} step="1" bind:value={blurIterations} />
        </div>
        <strong>{blurIterations} passes</strong>
      </label>

      <label>
        <span>Quality scale</span>
        <div class="input-row">
          <input type="range" min="0.5" max="4.0" step="0.05" bind:value={renderScale} />
          <input class="number" type="number" min="0.5" max="4.0" step="0.05" bind:value={renderScale} />
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

      <section class="layer-controls">
        <div class="layer-controls__head">
          <strong>Layers ({layers.length})</strong>
          <div class="layer-controls__actions">
            <button type="button" on:click={addLayer} disabled={layers.length >= MAX_LAYERS}>Add</button>
          </div>
        </div>
        {#each displayLayers as layer, index (layer.id)}
          <div class="layer-row">
            <span class="layer-row__order">
              <button
                type="button"
                class="layer-row__move"
                aria-label="Move layer up"
                title="Move layer up"
                disabled={index === 0}
                on:click={() => moveLayer(layer.id, 1)}>↑</button
              >
              <button
                type="button"
                class="layer-row__move"
                aria-label="Move layer down"
                title="Move layer down"
                disabled={index === displayLayers.length - 1}
                on:click={() => moveLayer(layer.id, -1)}>↓</button
              >
            </span>
            <input
              type="color"
              value={layer.color}
              on:input={(event) => updateLayerColor(layer.id, event.currentTarget.value)}
            />
            <input
              class="number"
              type="number"
              min="1"
              max={MAX_GRID}
              step="1"
              title="Layer grid width"
              aria-label="Layer grid width"
              value={layer.gridWidthUnits}
              on:input={(event) => updateLayerGrid(layer.id, "gridWidthUnits", event.currentTarget.value)}
            />
            <input
              class="number"
              type="number"
              min="1"
              max={MAX_GRID}
              step="1"
              title="Layer grid height"
              aria-label="Layer grid height"
              value={layer.gridHeightUnits}
              on:input={(event) => updateLayerGrid(layer.id, "gridHeightUnits", event.currentTarget.value)}
            />
            <button
              type="button"
              class="layer-row__random"
              title="Randomize this layer"
              aria-label="Randomize this layer"
              on:click={() => randomizeLayerMetaballs(layer.id)}>🎲</button
            >
              <button
                type="button"
                class="layer-row__remove"
                aria-label="Remove layer"
                title="Remove layer"
                disabled={layers.length <= 1}
                on:click={() => removeLayerById(layer.id)}>×</button
              >
          </div>
        {/each}
      </section>
    </div>

    <div class="stats">
      <span>Grid: {gridX} × {gridY}</span>
      <span>Circles: {activeCount}</span>
      <span>Layers: {layers.length}</span>
    </div>

    <div class="actions">
      <button type="button" on:click={exportPng}>Export PNG</button>
      <button type="button" on:click={exportSvg} class="ghost">Export SVG</button>
      <button type="button" on:click={randomizeAllLayers} class="ghost">Randomize all</button>
      <button type="button" on:click={randomizeLayerColors} class="ghost">Randomize colors</button>
      <button type="button" on:click={clearMask} class="ghost">Clear grid</button>
    </div>
  </section>

  <section
    class="canvas-wrap"
    class:show-grid={showGrid}
    bind:this={containerEl}
    style={`--cell:${cellSize}px; --canvas-w:${canvasWidthPx}px; --canvas-h:${canvasHeightPx}px; --canvas-scale:${canvasScale}; --canvas-display-w:${canvasDisplayWidthPx}px; --canvas-display-h:${canvasDisplayHeightPx}px;`}
  >
    <div class="canvas-stage">
      {#each layers as layer, index (layer.id)}
        <div
          class="color-layer"
          style={`--layer-color:${layer.color}; --offset-x:0px; --offset-y:0px; --mask-url:${layer.maskDataUrl ? `url('${layer.maskDataUrl}')` : "none"}; z-index:${index + 1};`}
        ></div>
      {/each}
      <canvas bind:this={canvasEl} class="canvas"></canvas>
    </div>
  </section>
</main>
