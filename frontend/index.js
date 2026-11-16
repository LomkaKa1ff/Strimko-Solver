// Extract straight links from a tightly cropped, regular Strimko grid.
// Reject unsupported images instead of substituting model-invented paths.
function detectBoardEdges(image, n) {
    const { width: w, height: h, data } = image;
    const dark = (x, y) => {
        x = Math.round(x); y = Math.round(y);
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        const i = (y * w + x) * 4;
        return data[i + 3] > 128 && (data[i] + data[i + 1] + data[i + 2]) / 3 < 175 ? 1 : 0;
    };
    let left = w, right = -1, top = h, bottom = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (dark(x, y)) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
    }
    if (right <= left || bottom <= top || n < 2) throw new Error('No regular grid found in the image.');
    const nearDark = (x, y, tolerance) => {
        for (let dy = -tolerance; dy <= tolerance; dy++) for (let dx = -tolerance; dx <= tolerance; dx++) {
            if (dark(x + dx, y + dy)) return 1;
        }
        return 0;
    };
    let best = null;
    for (let ratio = .22; ratio <= .43; ratio += .002) {
        const sx = (right - left) / (n - 1 + 2 * ratio);
        const sy = (bottom - top) / (n - 1 + 2 * ratio);
        const rx = sx * ratio, ry = sy * ratio;
        const tolerance = Math.max(1, Math.floor(Math.min(sx, sy) * .012));
        let score = 0;
        for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) {
            for (let k = 0; k < 32; k++) {
                const a = 2 * Math.PI * k / 32;
                score += nearDark(left + rx + col * sx + rx * Math.cos(a), top + ry + row * sy + ry * Math.sin(a), tolerance);
            }
        }
        score /= n * n * 32;
        if (!best || score > best.score) best = { score, sx, sy, rx, ry };
    }
    if (best.score < .8) throw new Error('Crop the image to a straight, regular grid with all circles visible.');
    const { sx, sy, rx, ry } = best;
    const points = Array.from({ length: n * n }, (_, id) => ({ x: left + rx + (id % n) * sx, y: top + ry + Math.floor(id / n) * sy }));
    const links = [];
    const adjacency = Array.from({ length: n * n }, () => []);
    const tolerance = Math.max(1, Math.floor(Math.min(sx, sy) * .02));
    for (let id = 0; id < n * n; id++) {
        const row = Math.floor(id / n), col = id % n;
        for (const [dr, dc] of [[0, 1], [1, -1], [1, 0], [1, 1]]) {
            const r = row + dr, c = col + dc;
            if (r >= n || c < 0 || c >= n) continue;
            const other = r * n + c;
            const a = points[id], b = points[other];
            // Sample both sides of crossings, away from the circle outlines.
            const support = [.40, .43, .46, .54, .57, .60].reduce((sum, t) => sum + nearDark(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y), tolerance), 0);
            if (support >= 5) {
                links.push(id + '-' + other);
                adjacency[id].push(other); adjacency[other].push(id);
            }
        }
    }

    const visited = new Set();
    let paths = 0;
    for (let id = 0; id < n * n; id++) {
        if (visited.has(id)) continue;
        const stack = [id], component = [];
        while (stack.length) {
            const current = stack.pop();
            if (visited.has(current)) continue;
            visited.add(current); component.push(current);
            for (const next of adjacency[current]) if (!visited.has(next)) stack.push(next);
        }
        if (component.length !== n) throw new Error('The detected lines do not form complete Strimko paths.');
        paths++;
    }
    if (paths !== n) throw new Error('The detected number of streams does not match the grid.');
    return links;
}

function detectBoardLayout(image) {
    for (let n = 2; n <= 16; n++) {
        try {
            return { size: n, edges: detectBoardEdges(image, n) };
        } catch { /* Try the next grid size; all geometry and connectivity checks must pass. */ }
    }
    throw new Error('Could not detect complete streams in a regular grid. Crop to the puzzle with all circles visible.');
}

async function readBoardEdges(file, n) {
    const bitmap = await createImageBitmap(file);
    try {
        const surface = document.createElement('canvas');
        const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
        surface.width = Math.round(bitmap.width * scale);
        surface.height = Math.round(bitmap.height * scale);
        const context = surface.getContext('2d', { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0, surface.width, surface.height);
        const image = context.getImageData(0, 0, surface.width, surface.height);
        return Number.isInteger(n) ? detectBoardEdges(image, n) : detectBoardLayout(image);
    } finally { bitmap.close(); }
}

let canvas, ctx, canvasContainer;
let size = 6;
let spacing, radius;
let circles = [];
let selectedCircles = [];
let edges = [];
let editingCircle = null;

function showMessage(message, isGreen = false) {
    const id = isGreen ? "messageContainerGreen" : "messageContainer";
    const container = document.getElementById(id);
    if (!container) return;
    container.textContent = message;
    container.classList.add("show");
    setTimeout(() => container.classList.remove("show"), 3000);
}

// Grid logic
function initGrid() {
    circles = [];
    spacing = canvas.width / size;
    radius = Math.min(20, spacing / 2 - 5);
    let idCounter = 0;
    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            const x = col * spacing + spacing / 2;
            const y = row * spacing + spacing / 2;
            circles.push({ id: idCounter++, row, col, x, y, number: null });
        }
    }
    selectedCircles = [];
    edges = [];
}

function getCircleById(id) {
    return circles.find(c => c.id === id);
}

function isInConnectedSet(id) {
    return edges.some(e => {
        let [u, v] = e.split('-');
        return parseInt(u) === id || parseInt(v) === id;
    });
}

// Visuals
function drawAll() {
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Edges
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.strokeStyle = "black";
    if (edges.length > 0) {
        ctx.beginPath();
        edges.forEach(e => {
            let [u, v] = e.split('-').map(Number);
            let cu = getCircleById(u);
            let cv = getCircleById(v);
            if (cu && cv) {
                ctx.moveTo(cu.x, cu.y);
                ctx.lineTo(cv.x, cv.y);
            }
        });
        ctx.stroke();
    }

    // Dashed
    if (selectedCircles.length > 1) {
        ctx.save();
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeStyle = "#6b7280";
        ctx.beginPath();
        selectedCircles.forEach((cid, index) => {
            const circle = getCircleById(cid);
            if (index === 0) ctx.moveTo(circle.x, circle.y);
            else ctx.lineTo(circle.x, circle.y);
        });
        ctx.stroke();
        ctx.restore();
    }

    // Circles
    circles.forEach(circle => {
        let fillColor = isInConnectedSet(circle.id) ? "#e2e8f0" : "white";
        ctx.beginPath();
        ctx.arc(circle.x, circle.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fillColor;
        ctx.fill();
        ctx.strokeStyle = "black";
        ctx.lineWidth = 2;
        ctx.stroke();

        if (circle.number !== null) {
            ctx.fillStyle = "black";
            ctx.font = "bold 16px 'DM Mono', monospace";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(circle.number, circle.x, circle.y);
        }
    });
}

function setupGameInterface() {
    const solveMethod = document.querySelector(".solveMethod");
    if (solveMethod) solveMethod.style.display = "none";

    const container = document.getElementById("manualFillContainer");
    if (!container) return;

    container.innerHTML = `
        <div class="content">
            <div id="canvasContainer">
                <canvas id="gridCanvas" width="600" height="600" style="touch-action: none;"></canvas>
            </div>
        </div>
        <div class="buttons solver-buttons">
            <button id="fillBtn">Solve</button>
            <button id="resetBtn">Reset</button>
            <button id="changeSizeBtn">Resize</button>
            <button onclick="window.location.href='index.html'" class="btn-return">Back</button>
        </div>
        <div id="messageContainer" class="message-container"></div>
        <div id="messageContainerGreen" class="message-container-green"></div>

        <div id="customPromptOverlay" class="custom-prompt-overlay">
            <div class="custom-prompt-box">
                <h3 id="customPromptTitle">Enter number</h3>
                <input type="number" id="customPromptInput" min="1" max="20">
                <div class="custom-prompt-buttons">
                    <button id="btnPromptSave">Save</button>
                    <button id="btnPromptClear">Clear</button>
                    <button id="btnPromptCancel">Cancel</button>
                </div>
            </div>
        </div>

        <div id="resizePromptOverlay" class="custom-prompt-overlay">
            <div class="custom-prompt-box">
                <h3>Enter grid size (2–20)</h3>
                <input type="number" id="resizePromptInput" min="2" max="20">
                <div class="custom-prompt-buttons">
                    <button id="btnResizeSave">Resize</button>
                    <button id="btnResizeCancel">Cancel</button>
                </div>
            </div>
        </div>
    `;

    canvas = document.getElementById("gridCanvas");
    ctx = canvas.getContext("2d");
    canvasContainer = document.getElementById("canvasContainer");

    attachCanvasEvents();
    attachButtonEvents();
}

function attachButtonEvents() {
    document.getElementById("fillBtn").addEventListener("click", fillNumbers);
    document.getElementById("resetBtn").addEventListener("click", () => {
        circles.forEach(c => c.number = null);
        edges = [];
        selectedCircles = [];
        drawAll();
    });
    document.getElementById("changeSizeBtn").addEventListener("click", openResizePrompt);

    // Numbers
    document.getElementById("btnPromptSave").addEventListener("click", saveCustomPrompt);
    document.getElementById("btnPromptClear").addEventListener("click", clearCustomPrompt);
    document.getElementById("btnPromptCancel").addEventListener("click", closeCustomPrompt);
    document.getElementById("customPromptOverlay").addEventListener("click", e => { if (e.target.id === 'customPromptOverlay') closeCustomPrompt(); });

    // Resize
    document.getElementById("btnResizeSave").addEventListener("click", saveResizePrompt);
    document.getElementById("btnResizeCancel").addEventListener("click", closeResizePrompt);
    document.getElementById("resizePromptOverlay").addEventListener("click", e => { if (e.target.id === 'resizePromptOverlay') closeResizePrompt(); });
}

function attachCanvasEvents() {
    let isTouching = false;

    canvas.addEventListener("click", (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        let clicked = circles.find(c => Math.hypot(c.x - x, c.y - y) <= radius);
        if (!clicked) return;

        if (e.shiftKey) {
            addCircleToSelection(clicked.id);
            drawAll();
        } else {
            openCustomPrompt(clicked);
        }
    });

    canvas.addEventListener("touchstart", (e) => {
        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;

        let clicked = circles.find(c => Math.hypot(c.x - x, c.y - y) <= radius);
        if (clicked) {
            isTouching = true;
            selectedCircles = [clicked.id];
            drawAll();
        }
    });

    canvas.addEventListener("touchmove", (e) => {
        if (!isTouching) return;
        const rect = canvas.getBoundingClientRect();
        const touch = e.touches[0];
        const x = touch.clientX - rect.left;
        const y = touch.clientY - rect.top;

        let found = circles.find(c => Math.hypot(c.x - x, c.y - y) <= radius);
        if (found && selectedCircles[selectedCircles.length - 1] !== found.id) {
            addCircleToSelection(found.id);
            drawAll();
        }
    });

    canvas.addEventListener("touchend", () => {
        if (!isTouching) return;
        if (selectedCircles.length > 1) commitSelectionToEdges();
        else if (selectedCircles.length === 1) openCustomPrompt(getCircleById(selectedCircles[0]));
        selectedCircles = [];
        isTouching = false;
        drawAll();
    });

    document.addEventListener("keyup", (e) => {
        if (e.key === "Shift") {
            if (selectedCircles.length > 1) commitSelectionToEdges();
            selectedCircles = [];
            drawAll();
        }
    });
}

function commitSelectionToEdges() {
    for (let i = 0; i < selectedCircles.length - 1; i++) {
        let u = selectedCircles[i];
        let v = selectedCircles[i + 1];
        if (u === v) continue;
        let edgeId = Math.min(u, v) + "-" + Math.max(u, v);
        let idx = edges.indexOf(edgeId);
        if (idx !== -1) edges.splice(idx, 1);
        else edges.push(edgeId);
    }
}

function addCircleToSelection(clickedId) {
    if (selectedCircles.length === 0) {
        selectedCircles.push(clickedId);
        return;
    }
    let lastId = selectedCircles[selectedCircles.length - 1];
    if (lastId === clickedId) return;

    let c1 = getCircleById(lastId);
    let c2 = getCircleById(clickedId);
    let dTotal = Math.hypot(c1.x - c2.x, c1.y - c2.y);

    let intermediate = circles.filter(c => {
        if (c.id === c1.id || c.id === c2.id) return false;
        let d1 = Math.hypot(c.x - c1.x, c.y - c1.y);
        let d2 = Math.hypot(c.x - c2.x, c.y - c2.y);
        return Math.abs(d1 + d2 - dTotal) < 1.0;
    }).sort((a, b) => Math.hypot(a.x - c1.x, a.y - c1.y) - Math.hypot(b.x - c1.x, b.y - c1.y));

    intermediate.forEach(c => {
        if (selectedCircles[selectedCircles.length - 1] !== c.id) selectedCircles.push(c.id);
    });
    if (selectedCircles[selectedCircles.length - 1] !== clickedId) selectedCircles.push(clickedId);
}

/* --- ЛОГИКА SOLVER (BACKTRACKING) --- */
function getChainsFromEdges() {
    let adj = {};
    circles.forEach(c => adj[c.id] = []);
    edges.forEach(e => {
        let [u, v] = e.split('-').map(Number);
        adj[u].push(v); adj[v].push(u);
    });

    let visited = new Set();
    let chains = [];
    circles.forEach(c => {
        if (!visited.has(c.id) && adj[c.id].length > 0) {
            let chain = [], q = [c.id];
            visited.add(c.id);
            while (q.length > 0) {
                let curr = q.shift();
                chain.push(curr);
                adj[curr].forEach(n => { if (!visited.has(n)) { visited.add(n); q.push(n); } });
            }
            chains.push(chain);
        }
    });
    return chains;
}

function isValidNumber(circle, number, chains) {
    for (let other of circles) {
        if (other.id !== circle.id && other.number === number &&
            (other.row === circle.row || other.col === circle.col)) return false;
    }
    for (let chain of chains) {
        if (chain.includes(circle.id)) {
            for (let cid of chain) {
                if (cid !== circle.id && getCircleById(cid).number === number) return false;
            }
        }
    }
    return true;
}

function fillNumbers() {
    const snapshot = circles.map(c => c.number);
    const chains = getChainsFromEdges();
    if (solve(0, chains)) {
        drawAll();
        showMessage("The grid was successfully filled.", true);
    } else {
        circles.forEach((c, i) => c.number = snapshot[i]);
        drawAll();
        showMessage("The grid could not be filled.");
    }
}

function solve(idx, chains) {
    if (idx === circles.length) return true;
    const circle = circles[idx];
    if (circle.number !== null) return solve(idx + 1, chains);
    for (let num = 1; num <= size; num++) {
        if (isValidNumber(circle, num, chains)) {
            circle.number = num;
            if (solve(idx + 1, chains)) return true;
            circle.number = null;
        }
    }
    return false;
}

/* --- МОДАЛЬНЫЕ ОКНА --- */
function openCustomPrompt(circle) {
    editingCircle = circle;
    document.getElementById('customPromptTitle').textContent = `Enter number (1–${size})`;
    document.getElementById('customPromptInput').value = circle.number || "";
    document.getElementById('customPromptOverlay').classList.add('show');
    setTimeout(() => document.getElementById('customPromptInput').focus(), 100);
}

function closeCustomPrompt() { document.getElementById('customPromptOverlay').classList.remove('show'); editingCircle = null; }

function saveCustomPrompt() {
    if (!editingCircle) return;
    const val = document.getElementById('customPromptInput').value.trim();
    if (val === "") { editingCircle.number = null; drawAll(); closeCustomPrompt(); return; }
    const num = parseInt(val);
    if (isNaN(num) || num < 1 || num > size) { showMessage(`Number must be 1–${size}`); return; }
    if (isValidNumber(editingCircle, num, getChainsFromEdges())) {
        editingCircle.number = num; drawAll(); closeCustomPrompt();
    } else { showMessage("Duplicate number!"); }
}

function clearCustomPrompt() { if (editingCircle) editingCircle.number = null; drawAll(); closeCustomPrompt(); }

function openResizePrompt() {
    document.getElementById('resizePromptInput').value = size;
    document.getElementById('resizePromptOverlay').classList.add('show');
    setTimeout(() => document.getElementById('resizePromptInput').focus(), 100);
}

function closeResizePrompt() { document.getElementById('resizePromptOverlay').classList.remove('show'); }

function saveResizePrompt() {
    const newSize = parseInt(document.getElementById('resizePromptInput').value);
    if (newSize >= 2 && newSize <= 20) {
        size = newSize; initGrid(); drawAll(); closeResizePrompt();
    } else { showMessage("Size must be 2–20"); }
}

document.addEventListener("DOMContentLoaded", () => {
    const btnFill = document.querySelector(".btn-fill");
    if (btnFill) {
        btnFill.addEventListener("click", () => {
            setupGameInterface();
            initGrid();
            drawAll();
        });
    }

    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            const statusBadge = document.querySelector('.screenshotOptionButton .status-badge');
            statusBadge.textContent = "Analyzing...";
            statusBadge.className = "status-badge success";

            try {
                let detectedLayout = null;
                try {
                    detectedLayout = await readBoardEdges(file);
                } catch { /* Numbers can still be imported for manual connections. */ }
                const formData = new FormData();
                if (detectedLayout) formData.append('gridSize', String(detectedLayout.size));
                formData.append('image', file);
                const response = await fetch('http://localhost:3000/api/analyze-board', { method: 'POST', body: formData });
                const data = await response.json().catch(() => null);
                if (!response.ok) {
                    throw new Error(data?.error || ('Server error (HTTP ' + response.status + ')'));
                }
                if (!data) throw new Error('Server returned an invalid response.');
                if (detectedLayout && data.size !== detectedLayout.size) {
                    throw new Error('The returned grid size does not match the image. Please restart the backend and try again.');
                }

                setupGameInterface();

                size = data.size;
                initGrid();
                data.circles.forEach(aiCircle => {
                    const target = getCircleById(aiCircle.id);
                    if (target) target.number = aiCircle.number;
                });
                // Read actual strokes from the uploaded image, including closed streams.
                // Model-generated streams can contain invented row-wise connections.
                edges = [];
                let lineError = null;
                try {
                    edges = detectedLayout ? detectedLayout.edges : await readBoardEdges(file, size);
                } catch (error) {
                    lineError = error;
                }
                drawAll();
                if (lineError) {
                    showMessage('Numbers loaded. Please add the connections manually.');
                    alert('Numbers loaded, but the connecting lines could not be read reliably. ' +
                        lineError.message + ' You can add connections with Shift + Click.');
                } else {
                    showMessage('Numbers and connecting lines loaded!', true);
                }
            } catch (error) {
                console.error(error);
                alert("AI Analysis failed: " + error.message);
            } finally {
                statusBadge.textContent = "Ready";
                fileInput.value = "";
            }
        });
    }
});