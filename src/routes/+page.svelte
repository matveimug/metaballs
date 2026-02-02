<script>
	import { onMount } from 'svelte';
	import * as THREE from 'three';

	let containerEl;
	let canvasEl;

	let cellSize = 100;
	let gridWidthUnits = 10;
	let gridHeightUnits = 10;
	let defaultDiameter = 1;
	let blurRadius = 3;
	let blurIterations = 15;
	let showGrid = true;

	let gridX = 0;
	let gridY = 0;
	let activeCount = 0;

	const MAX_GRID = 120;
	const circles = new Map();

	let isDragging = false;
	let dragStartCell = { x: 0, y: 0 };
	let activeCircleKey = null;
	let startedOnCircleKey = null;
	let dragMoved = false;

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

	let renderScale = 1.0;
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
		gridX = clamp(Math.round(gridWidthUnits), 1, MAX_GRID);
		gridY = clamp(Math.round(gridHeightUnits), 1, MAX_GRID);
		gridWidthUnits = gridX;
		gridHeightUnits = gridY;
	}

	function getCanvasSizePx() {
		return {
			width: gridX * cellSize,
			height: gridY * cellSize
		};
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
		const link = document.createElement('a');
		link.href = renderer.domElement.toDataURL('image/png');
		link.download = 'metaballs.png';
		link.click();
	}

	function randomizeCircles() {
		circles.clear();
		const cellsMin = 2;
		const cellsMax = 7;
		const marginCells = 1;
		const diameterList = [3, 2, 2, 1, 1, 1, 1, 1, 1, 1];

		for (const diameter of diameterList) {
			const isOdd = diameter % 2 === 1;
			let placed = false;
			for (let attempt = 0; attempt < 200 && !placed; attempt += 1) {
				const cellX = Math.floor(Math.random() * (cellsMax - cellsMin + 1)) + cellsMin;
				const cellY = Math.floor(Math.random() * (cellsMax - cellsMin + 1)) + cellsMin;
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
			y: clamp(y, 0, Math.max(0, gridY - 1))
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
		if (currentCell.x !== dragStartCell.x || currentCell.y !== dragStartCell.y) {
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
		maskCtx.fillStyle = '#000000';
		maskCtx.fillRect(0, 0, width, height);
		maskCtx.fillStyle = '#ffffff';
		const scale = width / Math.max(1, canvasEl.clientWidth);
		for (const circle of circles.values()) {
			const radius = (circle.diameter / 2) * cellSize * scale;
			const cx = (circle.xHalf / 2) * cellSize * scale;
			const cy = (circle.yHalf / 2) * cellSize * scale;
			maskCtx.beginPath();
			maskCtx.arc(cx, cy, radius, 0, Math.PI * 2);
			maskCtx.fill();
		}
		if (maskTexture) maskTexture.needsUpdate = true;
	}

	function render() {
		if (!renderer) return;
		const width = rtA.width;
		const height = rtA.height;
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
		const scaledWidth = Math.max(1, Math.floor(width * renderScale));
		const scaledHeight = Math.max(1, Math.floor(height * renderScale));

		maskCanvas = document.createElement('canvas');
		maskCanvas.width = scaledWidth;
		maskCanvas.height = scaledHeight;
		maskCtx = maskCanvas.getContext('2d');

		maskTexture = new THREE.CanvasTexture(maskCanvas);
		maskTexture.minFilter = THREE.LinearFilter;
		maskTexture.magFilter = THREE.LinearFilter;
		maskTexture.wrapS = THREE.ClampToEdgeWrapping;
		maskTexture.wrapT = THREE.ClampToEdgeWrapping;

		rtA = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			type: THREE.UnsignedByteType
		});
		rtB = new THREE.WebGLRenderTarget(scaledWidth, scaledHeight, {
			minFilter: THREE.LinearFilter,
			magFilter: THREE.LinearFilter,
			type: THREE.UnsignedByteType
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
				uRadius: { value: blurRadius }
			}
		});

		finalMaterial = new THREE.ShaderMaterial({
			vertexShader,
			fragmentShader: finalFragment,
			uniforms: {
				uInput: { value: maskTexture },
				uThreshold: { value: 0.5 }
			}
		});

		quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), finalMaterial);
		scene.add(quad);
	}

	function resizeRenderer(width, height) {
		if (!renderer) return;
		renderer.setSize(width, height, false);
		const scaledWidth = Math.max(1, Math.floor(width * renderScale));
		const scaledHeight = Math.max(1, Math.floor(height * renderScale));
		maskCanvas.width = scaledWidth;
		maskCanvas.height = scaledHeight;
		maskTexture.needsUpdate = true;
		rtA.setSize(scaledWidth, scaledHeight);
		rtB.setSize(scaledWidth, scaledHeight);
		blurMaterial.uniforms.uResolution.value.set(scaledWidth, scaledHeight);
		markDirty();
	}

	onMount(() => {
		renderer = new THREE.WebGLRenderer({ canvas: canvasEl, antialias: true, alpha: true });
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
		blurRadius;
		blurIterations;
		renderScale;
		showGrid;
		updateGridCounts();
		updateActiveCount();
		const { width, height } = getCanvasSizePx();
		resizeRenderer(width, height);
		markDirty();
	}
</script>

<svelte:head>
	<title>Grid Circle Lab</title>
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
			<h1>Grid Circle Lab</h1>
			<p>Drag from a corner to size; click a circle to erase.</p>
		</div>

		<div class="controls">
			<label>
				<span>Grid cell size (px)</span>
				<div class="input-row">
					<input type="range" min="25" max="200" step="1" bind:value={cellSize} />
					<input
						class="number"
						type="number"
						min="25"
						max="200"
						step="1"
						bind:value={cellSize}
					/>
				</div>
				<strong>{cellSize}px</strong>
			</label>

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
				<span>New circle diameter (grid units)</span>
				<div class="input-row">
					<input type="range" min="1" max="12" step="1" bind:value={defaultDiameter} />
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
				<span>Blur radius (px)</span>
				<div class="input-row">
					<input type="range" min="0" max={MAX_BLUR} step="1" bind:value={blurRadius} />
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
					<input type="range" min="1" max={MAX_ITER} step="1" bind:value={blurIterations} />
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
					<input type="range" min="0.5" max="1.5" step="0.05" bind:value={renderScale} />
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
			<button type="button" on:click={randomizeCircles} class="ghost">Randomize</button>
			<button type="button" on:click={clearMask} class="ghost">Clear grid</button>
		</div>
	</section>

	<section
		class="canvas-wrap"
		class:show-grid={showGrid}
		bind:this={containerEl}
		style={`--cell:${cellSize}px; --canvas-w:${gridX * cellSize}px; --canvas-h:${gridY * cellSize}px;`}
	>
		<canvas
			bind:this={canvasEl}
			class="canvas"
			on:pointerdown={onCanvasPointerDown}
			on:pointermove={onCanvasPointerMove}
			on:pointerup={onCanvasPointerUp}
		></canvas>
		<div class="overlay">Blur is GPU-based; higher iterations cost more.</div>
	</section>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family: 'Space Grotesk', system-ui, sans-serif;
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

	input[type='range'] {
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
		transition: transform 0.2s ease, box-shadow 0.2s ease;
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
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08), 0 20px 50px rgba(0, 0, 0, 0.1);
		--grid-line: rgba(0, 0, 0, 0.08);
		background-image:
			linear-gradient(to right, var(--grid-line) 1px, transparent 1px),
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

	.overlay {
		position: absolute;
		top: 16px;
		right: 16px;
		padding: 6px 12px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.85);
		border: 1px solid rgba(0, 0, 0, 0.1);
		font-size: 0.8rem;
		color: #2b2b2b;
		backdrop-filter: blur(8px);
		pointer-events: none;
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
