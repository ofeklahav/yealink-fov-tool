let cameras = [];

// Load devices from JSON
async function loadDevices() {
    try {
        const response = await fetch('devices.json');
        cameras = await response.json();
        init();
    } catch (error) {
        console.error('Failed to load devices:', error);
    }
}

// Data Parsers
function parseDoFMax(dofStr) {
    if (!dofStr || dofStr === "Not specified") return null;
    if (dofStr.includes("Infinity")) return Infinity;
    
    let max = null;
    if (dofStr.includes("-")) {
        const parts = dofStr.split("-");
        max = parseFloat(parts[1].replace(/[^\d.]/g, ''));
    } else if (dofStr.includes("Up to")) {
        const maxMatch = dofStr.match(/([\d.]+)/);
        if (maxMatch) max = parseFloat(maxMatch[1]);
    }
    return isNaN(max) ? null : max;
}

function parseAudio(audioStr) {
    if (!audioStr || audioStr.includes("N/A")) return null;
    const match = audioStr.match(/([\d.]+)/);
    if (match) return parseFloat(match[1]);
    return null;
}

// ── Custom Alert Modal ──
function showCustomAlert(msg, title) {
    const overlay = document.getElementById('alertModal');
    const msgEl = document.getElementById('alertModalMessage');
    const titleEl = document.getElementById('alertModalTitle');
    titleEl.textContent = title || 'הודעה';
    msgEl.textContent = msg;
    overlay.classList.add('open');
}

function closeCustomAlert() {
    document.getElementById('alertModal').classList.remove('open');
}

const RULER = 50;
const PPM = 90;

const canvas = document.getElementById('roomCanvas');
const container = document.getElementById('canvasContainer');
const ctx = canvas.getContext('2d');
const rotSlider = document.getElementById('camRotation');
const rotVal = document.getElementById('rotVal');

let room = { w: 4.8, h: 5.4 };
let table = { x: 2.4, y: 3.0, w: 1.4, h: 2.4 };
let cam = { x: 2.4, y: 0.1, rot: 90, hfov: 110, dofMax: null, audioRadius: null };
let chairs = [];

let multiCamEnabled = false;
let multiCamGroup = null; // 'avhub' or 'mtower'
let extraCams = [];
let lastExtraCamId = 0;

// Viewport State
let scale = 1.0;
let offsetX = 0;
let offsetY = 0;

// Interaction State
let dragTarget = null;
let isPanning = false;
let dragOffset = { x: 0, y: 0 };
let lastMouse = { x: 0, y: 0 };

// ── Camera & Lens Selection ──
let selectedCamIdx = 4; // MeetingBar A40
let selectedLensIdx = 0;

function getActiveLens(camDevice, lensIdx) {
    if (!camDevice || !camDevice.lenses) return null;
    return camDevice.lenses[lensIdx || 0];
}

function applyLensToMainCam(camDevice, lensIdx) {
    const lens = getActiveLens(camDevice, lensIdx);
    if (!lens) return;
    cam.hfov = lens.hfov;
    cam.dofMax = parseDoFMax(lens.dof);
    cam.audioRadius = parseAudio(lens.audio_pickup_range);
    updateChips(lens);
}

function updateChips(lens) {
    document.getElementById('fovDisplay').innerText = lens.hfov + '°';

    const dofChip = document.getElementById('chipDof');
    if (cam.dofMax) {
        dofChip.style.display = 'flex';
        document.getElementById('dofDisplay').innerText = (cam.dofMax === Infinity) ? '∞' : (cam.dofMax + 'm');
    } else {
        dofChip.style.display = 'none';
    }

    const audioChip = document.getElementById('chipAudio');
    if (lens.audio_pickup_range && !lens.audio_pickup_range.includes("N/A")) {
        audioChip.style.display = 'flex';
        document.getElementById('audioDisplay').innerText = lens.audio_pickup_range;
    } else {
        audioChip.style.display = 'none';
    }
}

function renderLensSegment(camDevice, activeIdx, onChange) {
    const field = document.getElementById('lensField');
    const segment = document.getElementById('lensSegment');
    segment.innerHTML = '';

    if (!camDevice.lenses || camDevice.lenses.length <= 1) {
        field.style.display = 'none';
        return;
    }

    field.style.display = 'block';
    camDevice.lenses.forEach((lens, i) => {
        const btn = document.createElement('button');
        btn.className = 'segment-btn' + (i === activeIdx ? ' active' : '');
        btn.type = 'button';
        btn.textContent = lens.label;
        btn.addEventListener('click', () => {
            segment.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            onChange(i);
        });
        segment.appendChild(btn);
    });
}

// ── Dropdown Graying ──
function updateDropdownDisabledState() {
    const scroll = document.getElementById('camScroll');
    const items = scroll.querySelectorAll('.cam-dd-item');
    items.forEach((el, i) => {
        if (multiCamEnabled) {
            const dev = cameras[i];
            let allowed = false;
            if (multiCamGroup === 'avhub') {
                allowed = !!dev.supports_avhub;
            } else if (multiCamGroup === 'mtower') {
                allowed = !!dev.supports_mtower;
            }
            el.classList.toggle('disabled', !allowed);
        } else {
            el.classList.remove('disabled');
        }
    });
}

function buildDropdown() {
    const scroll = document.getElementById('camScroll');
    const trigger = document.getElementById('camTrigger');
    const ddText = document.getElementById('camDdText');
    const dropdown = document.getElementById('camDropdown');

    cameras.forEach((c, i) => {
        const defaultLens = c.lenses[0];
        const item = document.createElement('div');
        item.className = 'cam-dd-item' + (i === selectedCamIdx ? ' active' : '');
        item.innerHTML = `
            <div class="cam-dd-item-left">
                <div class="cam-dd-dot"></div>
                <span class="cam-dd-name">${c.name}</span>
            </div>
            <span class="cam-dd-fov">${defaultLens.hfov}°</span>
        `;
        item.addEventListener('click', () => {
            if (item.classList.contains('disabled')) return;

            selectedCamIdx = i;
            selectedLensIdx = 0;
            applyLensToMainCam(c, 0);
            renderLensSegment(c, 0, (lensI) => {
                selectedLensIdx = lensI;
                applyLensToMainCam(c, lensI);
                updateChairsAndDraw();
            });

            // Handle multi-cam mode when switching main camera
            if (multiCamEnabled) {
                if (multiCamGroup === 'avhub' && !c.supports_avhub) {
                    disableMultiCam();
                    showCustomAlert("מצב ריבוי מצלמות בוטל כיוון שהמצלמה שנבחרה אינה תומכת במצב זה.");
                } else if (multiCamGroup === 'mtower' && !c.supports_mtower) {
                    disableMultiCam();
                    showCustomAlert("מצב ריבוי מצלמות בוטל כיוון שהמצלמה שנבחרה אינה תומכת במצב זה.");
                }
            }
            
            updateChairsAndDraw();
            
            ddText.textContent = c.name;
            scroll.querySelectorAll('.cam-dd-item').forEach((el, j) => {
                el.classList.toggle('active', j === i);
            });
            closeDropdown();
        });
        scroll.appendChild(item);
    });

    ddText.textContent = cameras[selectedCamIdx].name;

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        dropdown.classList.toggle('open');
    });

    document.addEventListener('click', closeDropdown);
}

function closeDropdown() {
    document.getElementById('camDropdown').classList.remove('open');
}

// ── Multi-Camera Management ──
function disableMultiCam() {
    multiCamEnabled = false;
    multiCamGroup = null;
    document.getElementById('multiCamToggle').checked = false;
    document.getElementById('multiCamControls').style.display = 'none';
    extraCams = [];
    updateDropdownDisabledState();
    renderExtraCamsList();
}

function populateAddCamOptions(group) {
    const select = document.getElementById('addCamSelect');
    select.innerHTML = '';
    const filtered = cameras.filter(device => {
        if (group === 'avhub') return device.supports_avhub;
        if (group === 'mtower') return device.is_mtower;
        return false;
    });
    filtered.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.name;
        opt.textContent = device.name;
        select.appendChild(opt);
    });
}

function renderExtraCamsList() {
    const listEl = document.getElementById('addedCamsList');
    listEl.innerHTML = '';
    extraCams.forEach((ec, idx) => {
        const device = cameras.find(c => c.name === ec.deviceName);
        const item = document.createElement('div');
        item.className = 'added-cam-item';
        
        const header = document.createElement('div');
        header.className = 'added-cam-header';
        
        const titleWrap = document.createElement('div');
        titleWrap.className = 'added-cam-title';
        titleWrap.innerHTML = `
            <span class="added-cam-badge">מצלמה ${idx + 2}</span>
            <span title="${ec.deviceName}">${ec.deviceName}</span>
        `;
        
        const removeBtn = document.createElement('button');
        removeBtn.className = 'added-cam-remove-btn';
        removeBtn.type = 'button';
        removeBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            </svg>
        `;
        removeBtn.addEventListener('click', () => {
            extraCams = extraCams.filter(c => c.id !== ec.id);
            renderExtraCamsList();
            updateChairsAndDraw();
        });
        
        header.appendChild(titleWrap);
        header.appendChild(removeBtn);
        item.appendChild(header);
        
        // Lens segment for extra cameras with multiple lenses
        if (device && device.lenses && device.lenses.length > 1) {
            const lensWrap = document.createElement('div');
            lensWrap.className = 'field';
            lensWrap.style.margin = '0';
            
            const lensLabel = document.createElement('label');
            lensLabel.className = 'fl';
            lensLabel.style.fontSize = '10px';
            lensLabel.style.marginBottom = '3px';
            lensLabel.textContent = 'עדשה';
            lensWrap.appendChild(lensLabel);
            
            const seg = document.createElement('div');
            seg.className = 'segment-control-mini';
            device.lenses.forEach((lens, li) => {
                const btn = document.createElement('button');
                btn.className = 'segment-btn-mini' + (li === ec.selectedLensIdx ? ' active' : '');
                btn.type = 'button';
                btn.textContent = lens.label;
                btn.addEventListener('click', () => {
                    ec.selectedLensIdx = li;
                    const selectedLens = device.lenses[li];
                    ec.hfov = selectedLens.hfov;
                    ec.dofMax = parseDoFMax(selectedLens.dof);
                    ec.audioRadius = parseAudio(selectedLens.audio_pickup_range);
                    renderExtraCamsList();
                    updateChairsAndDraw();
                });
                seg.appendChild(btn);
            });
            lensWrap.appendChild(seg);
            item.appendChild(lensWrap);
        }
        
        // Properties chips
        const activeLens = device ? device.lenses[ec.selectedLensIdx || 0] : null;
        const props = document.createElement('div');
        props.className = 'added-cam-props';
        
        const fChip = document.createElement('div');
        fChip.className = 'added-cam-prop-chip';
        fChip.innerText = `FOV: ${ec.hfov}°`;
        props.appendChild(fChip);
        
        if (ec.dofMax) {
            const dChip = document.createElement('div');
            dChip.className = 'added-cam-prop-chip';
            dChip.innerText = `DoF: ${ec.dofMax === Infinity ? '∞' : ec.dofMax + 'm'}`;
            props.appendChild(dChip);
        }
        
        if (ec.audioRadius) {
            const aChip = document.createElement('div');
            aChip.className = 'added-cam-prop-chip';
            aChip.innerText = `Mic: ${ec.audioRadius}m`;
            props.appendChild(aChip);
        }
        
        item.appendChild(props);
        
        // Rotation slider
        const rotField = document.createElement('div');
        rotField.className = 'field';
        rotField.style.margin = '4px 0 0 0';
        rotField.innerHTML = `
            <label class="fl" style="font-size: 10px; margin-bottom: 2px;">כיוון (סיבוב)</label>
            <div class="rot-row">
                <input type="range" min="0" max="360" value="${ec.rot}">
                <span class="rot-pill" style="font-size: 10.5px; padding: 2px 6px; min-width: 38px;">${ec.rot}°</span>
            </div>
        `;
        
        const slider = rotField.querySelector('input');
        const pill = rotField.querySelector('.rot-pill');
        slider.addEventListener('input', (e) => {
            ec.rot = parseInt(e.target.value);
            pill.innerText = ec.rot + '°';
            updateChairsAndDraw();
        });
        
        item.appendChild(rotField);
        listEl.appendChild(item);
    });
}

function init() {
    buildDropdown();

    const initialCam = cameras[selectedCamIdx];
    applyLensToMainCam(initialCam, 0);
    renderLensSegment(initialCam, 0, (lensI) => {
        selectedLensIdx = lensI;
        applyLensToMainCam(initialCam, lensI);
        updateChairsAndDraw();
    });

    rotSlider.addEventListener('input', (e) => {
        cam.rot = parseInt(e.target.value);
        rotVal.innerText = cam.rot + '°';
        updateChairsAndDraw();
    });

    ['roomW', 'roomH', 'tableW', 'tableH', 'tableDist'].forEach(id => {
        document.getElementById(id).addEventListener('input', readInputs);
    });

    // Multi-Camera Toggle & Controls
    const toggle = document.getElementById('multiCamToggle');
    const controls = document.getElementById('multiCamControls');
    const addBtn = document.getElementById('addCamBtn');

    toggle.addEventListener('change', (e) => {
        const activeCam = cameras[selectedCamIdx];
        if (e.target.checked) {
            if (activeCam.supports_avhub) {
                showCustomAlert("שים לב: מצב ריבוי מצלמות דורש יחידת AVHub לניהול וחיבור המצלמות.", "מצב AVHub");
                multiCamEnabled = true;
                multiCamGroup = 'avhub';
                controls.style.display = 'block';
                populateAddCamOptions('avhub');
                updateDropdownDisabledState();
                renderExtraCamsList();
            } else if (activeCam.supports_mtower) {
                showCustomAlert("שים לב: במצלמה זו ניתן לחבר מצלמת MTower כהרחבה שולחנית ללא צורך ב-AVHub.", "מצלמת MTower");
                multiCamEnabled = true;
                multiCamGroup = 'mtower';
                controls.style.display = 'block';
                populateAddCamOptions('mtower');
                updateDropdownDisabledState();
                renderExtraCamsList();
            } else {
                showCustomAlert("מצלמה זו אינה תומכת במצב ריבוי מצלמות או בחיבור מצלמת הרחבה.");
                e.target.checked = false;
                multiCamEnabled = false;
                multiCamGroup = null;
                controls.style.display = 'none';
            }
        } else {
            multiCamEnabled = false;
            multiCamGroup = null;
            controls.style.display = 'none';
            extraCams = [];
            updateDropdownDisabledState();
            updateChairsAndDraw();
        }
    });

    addBtn.addEventListener('click', () => {
        if (!multiCamEnabled) return;
        if (extraCams.length >= 3) {
            showCustomAlert("ניתן להוסיף עד 3 מצלמות נוספות בלבד.");
            return;
        }
        const select = document.getElementById('addCamSelect');
        const camName = select.value;
        const device = cameras.find(c => c.name === camName);
        if (device) {
            const defaultLens = device.lenses[0];
            extraCams.push({
                id: ++lastExtraCamId,
                deviceName: device.name,
                selectedLensIdx: 0,
                hfov: defaultLens.hfov,
                dofMax: parseDoFMax(defaultLens.dof),
                audioRadius: parseAudio(defaultLens.audio_pickup_range),
                rot: 90,
                x: room.w / 2 + (extraCams.length - 1) * 0.4,
                y: room.h / 2
            });
            renderExtraCamsList();
            updateChairsAndDraw();
        }
    });

    // Custom Alert Modal Handlers
    document.getElementById('alertModalOkBtn').addEventListener('click', closeCustomAlert);
    document.getElementById('closeAlertModalBtn').addEventListener('click', closeCustomAlert);
    document.getElementById('alertModal').addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeCustomAlert();
    });

    // Legend Popover Interaction
    const tooltipBtn = document.getElementById('legendTooltipBtn');
    const popover = document.getElementById('legendPopover');
    const closeBtn = document.getElementById('closeLegendBtn');

    tooltipBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        popover.classList.toggle('open');
    });

    closeBtn.addEventListener('click', () => {
        popover.classList.remove('open');
    });

    document.addEventListener('click', (e) => {
        if (!popover.contains(e.target) && e.target !== tooltipBtn) {
            popover.classList.remove('open');
        }
    });

    // Resize Handling
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();
    centerRoom();

    // Mouse/Touch Events
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerUp);
    
    // Wheel Zoom Event
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Controls
    document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(1.2));
    document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
    document.getElementById('btnResetView').addEventListener('click', centerRoom);

    readInputs();
}

function resizeCanvas() {
    canvas.width = container.clientWidth;
    canvas.height = container.clientHeight;
    draw();
}

function centerRoom() {
    scale = 1.0;
    offsetX = (canvas.width - RULER - room.w * PPM) / 2;
    offsetY = (canvas.height - RULER - room.h * PPM) / 2;
    updateZoomDisplay();
    draw();
}

function zoomBy(factor) {
    let newScale = scale * factor;
    newScale = Math.max(0.2, Math.min(newScale, 5));
    
    const cx = (canvas.width + RULER) / 2;
    const cy = (canvas.height + RULER) / 2;
    
    const wx = (cx - RULER - offsetX) / (PPM * scale);
    const wy = (cy - RULER - offsetY) / (PPM * scale);

    offsetX = cx - RULER - wx * PPM * newScale;
    offsetY = cy - RULER - wy * PPM * newScale;
    scale = newScale;
    
    updateZoomDisplay();
    draw();
}

function updateZoomDisplay() {
    document.getElementById('zoomDisplay').innerText = Math.round(scale * 100) + '%';
}

function readInputs(e) {
    room.w = parseFloat(document.getElementById('roomW').value) || 4.8;
    room.h = parseFloat(document.getElementById('roomH').value) || 5.4;
    table.w = parseFloat(document.getElementById('tableW').value) || 1.4;
    table.h = parseFloat(document.getElementById('tableH').value) || 2.4;
    
    if (!e || e.target.id === 'tableDist' || e.target.id === 'tableH') {
        let tDist = parseFloat(document.getElementById('tableDist').value) || 0;
        table.y = tDist + table.h / 2;
    }

    document.getElementById('roomDimDisplay').innerText = `${room.w} × ${room.h} מ׳`;
    document.getElementById('tableDimDisplay').innerText = `${table.w} × ${table.h} מ׳`;

    updateChairsAndDraw();
}

function generateChairs() {
    chairs = [];
    const chairSpacing = 0.65;
    const sideChairsCount = Math.max(1, Math.floor(table.h / chairSpacing));
    const startY = table.y - (sideChairsCount - 1) * chairSpacing / 2;

    for (let i = 0; i < sideChairsCount; i++) {
        let cy = startY + i * chairSpacing;
        chairs.push({ x: table.x - table.w / 2 - 0.25, y: cy, angle: 0 });
        chairs.push({ x: table.x + table.w / 2 + 0.25, y: cy, angle: 180 });
    }
    chairs.push({ x: table.x, y: table.y + table.h / 2 + 0.25, angle: 270 });
}

function checkSingleCamCoverage(c, px, py) {
    let dx = px - c.x;
    let dy = py - c.y;
    let dist = Math.hypot(dx, dy);

    let angleDeg = Math.atan2(dy, dx) * 180 / Math.PI;
    if (angleDeg < 0) angleDeg += 360;
    let diff = (angleDeg - c.rot + 180) % 360 - 180;
    let finalDiff = diff < -180 ? diff + 360 : diff;
    let inFov = Math.abs(finalDiff) <= c.hfov / 2;

    let inDof = true;
    if (c.dofMax && c.dofMax !== Infinity) {
        inDof = dist <= c.dofMax;
    }

    return inFov && inDof;
}

function checkFovCoverage(px, py) {
    if (checkSingleCamCoverage(cam, px, py)) return true;
    if (multiCamEnabled) {
        return extraCams.some(ec => checkSingleCamCoverage(ec, px, py));
    }
    return false;
}

function updateChairsAndDraw() {
    generateChairs();

    let insideCount = 0;
    chairs.forEach(c => {
        c.inside = checkFovCoverage(c.x, c.y);
        if (c.inside) insideCount++;
    });

    const pct = Math.round((insideCount / chairs.length) * 100);
    const metricEl = document.getElementById('coverageMetric');
    metricEl.innerText = `${pct}%`;
    document.getElementById('ringLabel').innerText = `${pct}%`;

    const circ = 169.6;
    const ring = document.getElementById('coverageRing');
    ring.style.strokeDashoffset = circ * (1 - pct / 100);

    metricEl.className = 'stats-pct';
    if (pct === 100) {
        metricEl.classList.add('s-perfect');
        ring.style.stroke = '#137333';
    } else if (pct >= 60) {
        metricEl.classList.add('s-good');
        ring.style.stroke = '#1967D2';
    } else {
        metricEl.classList.add('s-low');
        ring.style.stroke = '#C5221F';
    }

    draw();
}

/* ─── INTERACTIONS ─── */
function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    if (mx < RULER || my < RULER) return;

    const zoomIntensity = 0.002;
    const delta = -e.deltaY * zoomIntensity;
    let newScale = scale * Math.exp(delta);
    newScale = Math.max(0.2, Math.min(newScale, 5));

    const wx = (mx - RULER - offsetX) / (PPM * scale);
    const wy = (my - RULER - offsetY) / (PPM * scale);

    offsetX = mx - RULER - wx * PPM * newScale;
    offsetY = my - RULER - wy * PPM * newScale;
    scale = newScale;

    updateZoomDisplay();
    draw();
}

function onPointerDown(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    lastMouse = { x: mx, y: my };

    if (mx < RULER || my < RULER) return;

    const wx = (mx - RULER - offsetX) / (PPM * scale);
    const wy = (my - RULER - offsetY) / (PPM * scale);

    if (multiCamEnabled) {
        for (let i = 0; i < extraCams.length; i++) {
            const ec = extraCams[i];
            const ecPx = RULER + offsetX + ec.x * PPM * scale;
            const ecPy = RULER + offsetY + ec.y * PPM * scale;
            if (Math.hypot(mx - ecPx, my - ecPy) < 25) {
                dragTarget = { type: 'extraCam', id: ec.id };
                canvas.setPointerCapture(e.pointerId);
                return;
            }
        }
    }

    const camPx = RULER + offsetX + cam.x * PPM * scale;
    const camPy = RULER + offsetY + cam.y * PPM * scale;
    if (Math.hypot(mx - camPx, my - camPy) < 25) {
        dragTarget = 'cam';
        canvas.setPointerCapture(e.pointerId);
        return;
    }

    const tX = RULER + offsetX + table.x * PPM * scale;
    const tY = RULER + offsetY + table.y * PPM * scale;
    const tW = table.w * PPM * scale;
    const tH = table.h * PPM * scale;
    if (mx > tX - tW / 2 && mx < tX + tW / 2 && my > tY - tH / 2 && my < tY + tH / 2) {
        dragTarget = 'table';
        dragOffset.x = wx - table.x;
        dragOffset.y = wy - table.y;
        canvas.setPointerCapture(e.pointerId);
        return;
    }

    isPanning = true;
    canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const dx = mx - lastMouse.x;
    const dy = my - lastMouse.y;
    lastMouse = { x: mx, y: my };

    const camPx = RULER + offsetX + cam.x * PPM * scale;
    const camPy = RULER + offsetY + cam.y * PPM * scale;
    const tX = RULER + offsetX + table.x * PPM * scale;
    const tY = RULER + offsetY + table.y * PPM * scale;
    const tW = table.w * PPM * scale;
    const tH = table.h * PPM * scale;

    let hoverTarget = null;
    if (multiCamEnabled) {
        for (let i = 0; i < extraCams.length; i++) {
            const ec = extraCams[i];
            const ecPx = RULER + offsetX + ec.x * PPM * scale;
            const ecPy = RULER + offsetY + ec.y * PPM * scale;
            if (Math.hypot(mx - ecPx, my - ecPy) < 25) {
                hoverTarget = 'extraCam';
                break;
            }
        }
    }

    if (dragTarget || isPanning) {
        canvas.style.cursor = 'grabbing';
    } else if (Math.hypot(mx - camPx, my - camPy) < 25 || hoverTarget ||
               (mx > tX - tW / 2 && mx < tX + tW / 2 && my > tY - tH / 2 && my < tY + tH / 2)) {
        canvas.style.cursor = 'grab';
    } else {
        canvas.style.cursor = 'default';
    }

    if (isPanning) {
        offsetX += dx;
        offsetY += dy;
        draw();
        return;
    }

    if (!dragTarget) return;

    const wx = (mx - RULER - offsetX) / (PPM * scale);
    const wy = (my - RULER - offsetY) / (PPM * scale);

    if (dragTarget === 'cam') {
        cam.x = Math.max(0, Math.min(room.w, wx));
        cam.y = Math.max(0, Math.min(room.h, wy));
    } else if (typeof dragTarget === 'object' && dragTarget.type === 'extraCam') {
        const ec = extraCams.find(c => c.id === dragTarget.id);
        if (ec) {
            ec.x = Math.max(0, Math.min(room.w, wx));
            ec.y = Math.max(0, Math.min(room.h, wy));
        }
    } else if (dragTarget === 'table') {
        table.x = Math.max(table.w / 2, Math.min(room.w - table.w / 2, wx - dragOffset.x));
        table.y = Math.max(table.h / 2, Math.min(room.h - table.h / 2, wy - dragOffset.y));
        document.getElementById('tableDist').value = Math.max(0, table.y - table.h / 2).toFixed(2);
    }
    updateChairsAndDraw();
}

function onPointerUp(e) {
    isPanning = false;
    if (dragTarget) {
        canvas.releasePointerCapture(e.pointerId);
        dragTarget = null;
    }
}

/* ─── RENDER ─── */
function draw() {
    ctx.fillStyle = '#0D1117';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const minW_X = -offsetX / (PPM * scale);
    const maxW_X = (canvas.width - RULER - offsetX) / (PPM * scale);
    const minW_Y = -offsetY / (PPM * scale);
    const maxW_Y = (canvas.height - RULER - offsetY) / (PPM * scale);

    drawGrid(minW_X, maxW_X, minW_Y, maxW_Y);

    ctx.save();
    ctx.rect(RULER, RULER, canvas.width - RULER, canvas.height - RULER);
    ctx.clip();
    ctx.translate(RULER + offsetX, RULER + offsetY);
    ctx.scale(scale, scale);

    // Draw Room Boundary Box
    ctx.fillStyle = 'rgba(255,255,255,0.015)';
    ctx.fillRect(0, 0, room.w * PPM, room.h * PPM);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([5 / scale, 5 / scale]);
    ctx.strokeRect(0, 0, room.w * PPM, room.h * PPM);
    ctx.setLineDash([]);

    drawFOV();
    drawTableAndChairs();
    drawCamera();
    
    ctx.restore();

    drawRulers(minW_X, maxW_X, minW_Y, maxW_Y);
}

function drawGrid(minX, maxX, minY, maxY) {
    ctx.save();
    ctx.rect(RULER, RULER, canvas.width - RULER, canvas.height - RULER);
    ctx.clip();

    // 0.5m lines
    ctx.strokeStyle = 'rgba(255,255,255,0.028)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let startGridX = Math.floor(minX / 0.5) * 0.5;
    for(let wx = startGridX; wx <= maxX; wx += 0.5) {
        let sx = RULER + offsetX + wx * PPM * scale;
        ctx.moveTo(sx, RULER); ctx.lineTo(sx, canvas.height);
    }
    let startGridY = Math.floor(minY / 0.5) * 0.5;
    for(let wy = startGridY; wy <= maxY; wy += 0.5) {
        let sy = RULER + offsetY + wy * PPM * scale;
        ctx.moveTo(RULER, sy); ctx.lineTo(canvas.width, sy);
    }
    ctx.stroke();
    
    // 1.0m lines
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.beginPath();
    let startGridX2 = Math.floor(minX / 1.0) * 1.0;
    for(let wx = startGridX2; wx <= maxX; wx += 1.0) {
        let sx = RULER + offsetX + wx * PPM * scale;
        ctx.moveTo(sx, RULER); ctx.lineTo(sx, canvas.height);
    }
    let startGridY2 = Math.floor(minY / 1.0) * 1.0;
    for(let wy = startGridY2; wy <= maxY; wy += 1.0) {
        let sy = RULER + offsetY + wy * PPM * scale;
        ctx.moveTo(RULER, sy); ctx.lineTo(canvas.width, sy);
    }
    ctx.stroke();

    ctx.restore();
}

function drawRulers(minX, maxX, minY, maxY) {
    ctx.fillStyle = '#121820';
    ctx.fillRect(0, 0, canvas.width, RULER);
    ctx.fillRect(0, 0, RULER, canvas.height);

    ctx.fillStyle = '#0D1117';
    ctx.fillRect(0, 0, RULER, RULER);

    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(RULER, 0); ctx.lineTo(RULER, canvas.height); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, RULER); ctx.lineTo(canvas.width, RULER); ctx.stroke();

    // Origin Arrows
    if (offsetX > 0 && offsetY > 0) {
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.fillStyle = 'rgba(255,255,255,0.3)';
        ctx.font = '10px "JetBrains Mono", monospace';
        
        ctx.beginPath(); ctx.moveTo(RULER, RULER); ctx.lineTo(RULER + 12, RULER); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(RULER + 12, RULER); ctx.lineTo(RULER + 8, RULER - 3); ctx.lineTo(RULER + 8, RULER + 3); ctx.fill();
        ctx.fillText("X", RULER + 20, RULER + 3);

        ctx.beginPath(); ctx.moveTo(RULER, RULER); ctx.lineTo(RULER, RULER + 12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(RULER, RULER + 12); ctx.lineTo(RULER - 3, RULER + 8); ctx.lineTo(RULER + 3, RULER + 8); ctx.fill();
        ctx.fillText("Y", RULER + 8, RULER + 22);
    }

    ctx.fillStyle = '#6B7588';
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // X Ruler
    let startX = Math.floor(minX / 0.5) * 0.5;
    for(let wx = startX; wx <= maxX; wx += 0.5) {
        let px = RULER + offsetX + wx * PPM * scale;
        if (px < RULER) continue;
        
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(px, RULER - 6); ctx.lineTo(px, RULER); ctx.stroke();
        
        if (Math.abs(wx % 1.0) < 0.01 || Math.abs(Math.abs(wx % 1.0) - 1.0) < 0.01 || Math.abs(wx) < 0.01) {
            ctx.fillText(Math.abs(wx) < 0.01 ? "0.0" : wx.toFixed(1), px, RULER / 2);
        }
    }

    // Y Ruler
    ctx.textAlign = 'right';
    let startY = Math.floor(minY / 0.5) * 0.5;
    for(let wy = startY; wy <= maxY; wy += 0.5) {
        let py = RULER + offsetY + wy * PPM * scale;
        if (py < RULER) continue;

        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(RULER - 6, py); ctx.lineTo(RULER, py); ctx.stroke();
        
        if (Math.abs(wy % 1.0) < 0.01 || Math.abs(Math.abs(wy % 1.0) - 1.0) < 0.01 || Math.abs(wy) < 0.01) {
            ctx.fillText(Math.abs(wy) < 0.01 ? "0.0" : wy.toFixed(1), RULER - 9, py);
        }
    }
}

function drawSingleCamFOV(c) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;
    const rDefault = 2000;
    const angleRad = (c.rot * Math.PI) / 180;
    const fovRad = (c.hfov * Math.PI) / 180;
    const startAngle = angleRad - fovRad / 2;
    const endAngle = angleRad + fovRad / 2;

    if (c.audioRadius) {
        const ar = c.audioRadius * PPM;
        ctx.fillStyle = 'rgba(245, 158, 11, 0.04)'; 
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([8 / scale, 6 / scale]);
        ctx.beginPath();
        
        const arcStart = angleRad - Math.PI/2;
        const arcEnd = angleRad + Math.PI/2;
        
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, ar, arcStart, arcEnd);
        ctx.closePath();
        
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (c.dofMax) {
        const dofMaxPx = c.dofMax === Infinity ? 30 * PPM : c.dofMax * PPM; 
        const visualMax = Math.min(dofMaxPx, 30 * PPM);

        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, visualMax);
        grad.addColorStop(0, 'rgba(25,103,210,0.3)');
        grad.addColorStop(1, 'rgba(25,103,210,0)');

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.arc(cx, cy, dofMaxPx, startAngle, endAngle);
        ctx.closePath();
        ctx.fill();
    }

    ctx.strokeStyle = 'rgba(59,130,246,0.45)';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([6 / scale, 5 / scale]);
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(startAngle) * rDefault, cy + Math.sin(startAngle) * rDefault);
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(endAngle) * rDefault, cy + Math.sin(endAngle) * rDefault);
    ctx.stroke();
    ctx.setLineDash([]);
}

function drawFOV() {
    drawSingleCamFOV(cam);
    if (multiCamEnabled) {
        extraCams.forEach(ec => drawSingleCamFOV(ec));
    }
}

function drawTableAndChairs() {
    chairs.forEach(c => {
        const cx = c.x * PPM;
        const cy = c.y * PPM;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate((c.angle * Math.PI) / 180);

        if (c.inside) {
            ctx.strokeStyle = 'rgba(16,185,129,0.9)';
            ctx.fillStyle = 'rgba(16,185,129,0.12)';
        } else {
            ctx.strokeStyle = 'rgba(239,68,68,0.5)';
            ctx.fillStyle = 'rgba(239,68,68,0.05)';
        }

        ctx.lineWidth = 1.8 / scale;
        ctx.beginPath();
        ctx.roundRect(-15, -15, 30, 30, 5);
        ctx.fill();
        ctx.stroke();

        const sColor  = c.inside ? 'rgba(16,185,129,0.85)' : 'rgba(239,68,68,0.5)';
        const sFill   = c.inside ? 'rgba(16,185,129,0.13)' : 'rgba(239,68,68,0.06)';

        ctx.fillStyle   = sFill;
        ctx.strokeStyle = sColor;
        ctx.lineWidth   = 1.8 / scale;
        ctx.beginPath();
        ctx.roundRect(-11, -11, 22, 22, 4);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = sColor;
        ctx.beginPath();
        ctx.roundRect(-16, -11, 6, 22, 3);
        ctx.fill();

        ctx.restore();
    });

    const tx = (table.x - table.w / 2) * PPM;
    const ty = (table.y - table.h / 2) * PPM;
    const tw = table.w * PPM;
    const th = table.h * PPM;

    ctx.fillStyle = 'rgba(139,92,246,0.10)';
    ctx.strokeStyle = 'rgba(139,92,246,0.7)';
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.roundRect(tx, ty, tw, th, 10);
    ctx.fill();
    ctx.stroke();

    ctx.save();
    ctx.translate(tx + tw / 2, ty + th / 2);
    ctx.fillStyle = 'rgba(196,181,253,0.85)';
    ctx.scale(1/scale, 1/scale);
    ctx.font = 'bold 12px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${table.w}m × ${table.h}m`, 0, 0);
    ctx.restore();
}

function drawSingleCamera(c, label) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;

    ctx.strokeStyle = 'rgba(59,130,246,0.2)';
    ctx.lineWidth = 8 / scale;
    ctx.beginPath();
    ctx.arc(cx, cy, 18, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = label === "1" ? '#1967D2' : '#8B5CF6';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5 / scale;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
        cx + Math.cos((c.rot * Math.PI) / 180) * 14,
        cy + Math.sin((c.rot * Math.PI) / 180) * 14
    );
    ctx.stroke();
    ctx.lineCap = 'butt';

    if (multiCamEnabled) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.fillStyle = '#ffffff';
        ctx.scale(1/scale, 1/scale);
        ctx.font = 'bold 9px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, 0, -22 * scale);
        ctx.restore();
    }
}

function drawCamera() {
    drawSingleCamera(cam, "1");
    if (multiCamEnabled) {
        extraCams.forEach((ec, idx) => {
            drawSingleCamera(ec, (idx + 2).toString());
        });
    }
}

// Load devices and initialize
loadDevices();
