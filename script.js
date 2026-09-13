let cameras = [];

window.devicesData = [];
window.availableMics = [];
window.availableSpeakers = [];
window.availableDisplays = [];

// Load devices from JSON
async function loadDevices() {
    try {
        const [res1, res2] = await Promise.all([
            fetch('devices.json'),
            fetch('devices2.json').catch(e => { console.warn(e); return { json: () => ({}) }; })
        ]);
        
        cameras = await res1.json();
        cameras.forEach(c => c.device_type = 'camera');
        window.devicesData = [...cameras];

        let data2 = {};
        try { data2 = await res2.json(); } catch(e) {}

        if (data2.audio_solutions) {
            const mics = [];
            const speakers = [];
            
            ['ceiling_microphones', 'wired_microphones', 'wireless_microphones'].forEach(cat => {
                if (data2.audio_solutions[cat]) {
                    data2.audio_solutions[cat].forEach(d => {
                        d.device_type = 'microphone';
                        mics.push(d);
                    });
                }
            });
            if (data2.audio_solutions.speakers) {
                data2.audio_solutions.speakers.forEach(d => {
                    d.device_type = 'speaker';
                    speakers.push(d);
                });
            }
            window.devicesData.push(...mics, ...speakers);
        }

        if (data2.interactive_displays_and_boards) {
            data2.interactive_displays_and_boards.forEach(d => {
                if (!d.name.toLowerCase().includes('board') && !d.name.toLowerCase().includes('deskvision')) {
                    d.device_type = 'display';
                    window.devicesData.push(d);
                }
            });
        }
        
        window.availableMics = window.devicesData.filter(d => d.device_type === 'microphone');
        window.availableSpeakers = window.devicesData.filter(d => d.device_type === 'speaker');
        window.availableDisplays = window.devicesData.filter(d => d.device_type === 'display');

        window.availableOthers = [];
        const processCategory = (catData) => {
            if (Array.isArray(catData)) {
                catData.forEach(d => { d.device_type = 'other'; window.availableOthers.push(d); });
            } else if (typeof catData === 'object' && catData !== null) {
                Object.values(catData).forEach(subCat => {
                    if (Array.isArray(subCat)) {
                        subCat.forEach(d => { d.device_type = 'other'; window.availableOthers.push(d); });
                    }
                });
            }
        };

        if (data2.adapters_switches_and_infrastructure) processCategory(data2.adapters_switches_and_infrastructure);
        if (data2.control_panels_remotes_and_sensors) processCategory(data2.control_panels_remotes_and_sensors);
        if (data2.mini_pcs_and_processing_units) processCategory(data2.mini_pcs_and_processing_units);

        window.devicesData.push(...window.availableOthers);

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
    if (!audioStr) return null;
    const match = audioStr.match(/([\d.]+)/);
    return match ? parseFloat(match[1]) : null;
}

function parseRadius(pickupStr) {
    if (!pickupStr) return 0;
    const match = pickupStr.match(/([\d.]+)\s*m/);
    if (match) {
        let val = parseFloat(match[1]);
        if (!pickupStr.toLowerCase().includes('radius')) {
            val = val / 2;
        }
        return val;
    }
    return 0;
}

function parseAngle(angleStr) {
    if (!angleStr) return 0;
    const match = angleStr.match(/([\d.]+)\s*°/);
    if (match) return parseFloat(match[1]);
    return 0;
}

function parseDisplaySize(name) {
    if (!name) return 1.44; 
    const match = name.match(/([\d.]+)\s*"/);
    if (match) {
        const inches = parseFloat(match[1]);
        return inches * 0.0254 * 0.8716; // 16:9 width
    }
    return 1.44;
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

const RULER = 0;
const PPM = 90;

const canvas = document.getElementById('roomCanvas');
const container = document.getElementById('canvasContainer');
const ctx = canvas.getContext('2d');
const rotSlider = document.getElementById('camRotation');
const rotVal = document.getElementById('rotVal');

let fovDisplayMode = 'fill'; // 'fill', 'outline', 'hidden'
let micDisplayMode = 'fill'; // 'fill', 'outline', 'hidden'

let room = { w: 4.8, h: 5.4 };
let table = { x: 2.4, y: 3.0, w: 1.4, h: 2.4 };
let tableShape = 'rectangular';
let isSnappedX = false;
let isSnappedY = false;
let selectedObject = null;
let cam = { x: 2.4, y: 0.1, rot: 90, hfov: 110, dofMax: null, audioRadius: null };
let chairs = [];

let multiCamEnabled = false;
let multiCamGroup = 'avhub'; // 'avhub' or 'mtower'
let extraCams = [];
let extraDisplays = [];
let extraMics = [];
let extraSpeakers = [];
let extraOthers = [];
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

let undoStack = [];
let redoStack = [];

class StateManager {
    static getProjects() {
        try {
            const data = localStorage.getItem('av_planner_projects');
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    }
    static saveProjects(projects) {
        localStorage.setItem('av_planner_projects', JSON.stringify(projects));
    }
    static getCurrentProjectId() {
        return localStorage.getItem('av_planner_current_id');
    }
    static setCurrentProjectId(id) {
        if (id) {
            localStorage.setItem('av_planner_current_id', id);
        } else {
            localStorage.removeItem('av_planner_current_id');
        }
    }
    static createProject(name) {
        const projects = this.getProjects();
        const newProject = {
            id: Date.now().toString(),
            name: name,
            createdAt: new Date().toISOString(),
            room: { w: 4.8, h: 5.4 },
            table: { x: 2.4, y: 3.0, w: 1.4, h: 2.4 },
            tableShape: 'rectangular',
            cam: { x: 2.4, y: 0.1, rot: 90, hfov: 110, dofMax: null, audioRadius: null },
            selectedCamIdx: 4,
            selectedLensIdx: 0,
            multiCamEnabled: false,
            multiCamGroup: 'avhub',
            extraCams: [],
            extraMics: [],
            extraSpeakers: [],
            extraDisplays: [],
            extraOthers: []
        };
        projects.push(newProject);
        this.saveProjects(projects);
        return newProject;
    }
    static captureState() {
        return JSON.stringify({
            room, table, tableShape, cam, selectedCamIdx, selectedLensIdx,
            multiCamEnabled, multiCamGroup, extraCams, extraMics, extraSpeakers, extraDisplays, extraOthers
        });
    }
    static applyState(stateStr) {
        if (!stateStr) return;
        const p = JSON.parse(stateStr);
        room = { ...p.room };
        table = { ...p.table };
        tableShape = p.tableShape || 'rectangular';
        cam = { ...p.cam };
        selectedCamIdx = p.selectedCamIdx;
        selectedLensIdx = p.selectedLensIdx;
        multiCamEnabled = p.multiCamEnabled;
        multiCamGroup = p.multiCamGroup || 'avhub';
        extraCams = p.extraCams ? JSON.parse(JSON.stringify(p.extraCams)) : [];
        extraMics = p.extraMics ? JSON.parse(JSON.stringify(p.extraMics)) : [];
        extraSpeakers = p.extraSpeakers ? JSON.parse(JSON.stringify(p.extraSpeakers)) : [];
        extraDisplays = p.extraDisplays ? JSON.parse(JSON.stringify(p.extraDisplays)) : [];
        extraOthers = p.extraOthers ? JSON.parse(JSON.stringify(p.extraOthers)) : [];
        syncUIWithState();
    }
    static undo() {
        if (undoStack.length <= 1) return;
        redoStack.push(undoStack.pop());
        this.applyState(undoStack[undoStack.length - 1]);
        this.saveCurrentState(true);
        updateUndoRedoUI();
    }
    static redo() {
        if (redoStack.length === 0) return;
        const nextState = redoStack.pop();
        undoStack.push(nextState);
        this.applyState(nextState);
        this.saveCurrentState(true);
        updateUndoRedoUI();
    }
    static saveCurrentState(skipHistory = false) {
        if (!skipHistory) {
            const state = this.captureState();
            if (undoStack.length === 0 || undoStack[undoStack.length - 1] !== state) {
                undoStack.push(state);
                redoStack = [];
                if (undoStack.length > 50) undoStack.shift();
            }
        }
        
        const currentId = this.getCurrentProjectId();
        if (!currentId) return;
        const projects = this.getProjects();
        const idx = projects.findIndex(p => p.id === currentId);
        if (idx !== -1) {
            projects[idx] = {
                ...projects[idx],
                room, table, tableShape, cam, selectedCamIdx, selectedLensIdx,
                multiCamEnabled, multiCamGroup, extraCams, extraMics, extraSpeakers, extraDisplays, extraOthers,
                updatedAt: new Date().toISOString()
            };
            this.saveProjects(projects);
        }
        updateUndoRedoUI();
    }
    static loadProject(id) {
        const projects = this.getProjects();
        const p = projects.find(p => p.id === id);
        if (p) {
            room = { ...p.room };
            table = { ...p.table };
            tableShape = p.tableShape || 'rectangular';
            tableShape = p.tableShape || 'rectangular';
            cam = { ...p.cam };
            selectedCamIdx = p.selectedCamIdx;
            selectedLensIdx = p.selectedLensIdx;
            multiCamEnabled = p.multiCamEnabled;
            multiCamGroup = p.multiCamGroup || 'avhub';
            extraCams = p.extraCams ? JSON.parse(JSON.stringify(p.extraCams)) : [];
            extraMics = p.extraMics ? JSON.parse(JSON.stringify(p.extraMics)) : [];
            extraSpeakers = p.extraSpeakers ? JSON.parse(JSON.stringify(p.extraSpeakers)) : [];
            extraDisplays = p.extraDisplays ? JSON.parse(JSON.stringify(p.extraDisplays)) : [];
            this.setCurrentProjectId(id);
            undoStack = [this.captureState()];
            redoStack = [];
            
            const nameDisplay = document.getElementById('projectNameDisplay');
            if (nameDisplay) nameDisplay.textContent = p.name;
            
            return true;
        }
        return false;
    }
    static deleteProject(id) {
        const projects = this.getProjects().filter(p => p.id !== id);
        this.saveProjects(projects);
        if (this.getCurrentProjectId() === id) {
            this.setCurrentProjectId(null);
        }
    }
}

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
        if (c.name.toLowerCase() === 'mb-12x pro') return;
        
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
            StateManager.saveCurrentState();
            
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
    document.querySelectorAll('.cam-dropdown.open').forEach(el => el.classList.remove('open'));
}

function initCustomDropdown(dropdownId, triggerId, scrollId, textId, options, onSelect, selectedValue) {
    const dropdown = document.getElementById(dropdownId);
    const trigger = document.getElementById(triggerId);
    const scroll = document.getElementById(scrollId);
    const text = document.getElementById(textId);
    if (!dropdown || !trigger || !scroll || !text) return;

    scroll.innerHTML = '';
    
    let activeIdx = 0;
    if (selectedValue) {
        const idx = options.findIndex(o => o.value === selectedValue);
        if (idx !== -1) activeIdx = idx;
    }

    if (options.length > 0) {
        text.textContent = options[activeIdx].label;
    }

    options.forEach((opt, i) => {
        const item = document.createElement('div');
        item.className = 'cam-dd-item' + (i === activeIdx ? ' active' : '');
        item.innerHTML = `
            <div class="cam-dd-item-left">
                <div class="cam-dd-dot"></div>
                <span class="cam-dd-name">${opt.label}</span>
            </div>
        `;
        item.addEventListener('click', () => {
            if (item.classList.contains('disabled')) return;
            text.textContent = opt.label;
            scroll.querySelectorAll('.cam-dd-item').forEach(el => el.classList.remove('active'));
            item.classList.add('active');
            closeDropdown();
            if (onSelect) onSelect(opt.value);
        });
        scroll.appendChild(item);
    });

    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        closeDropdown();
        if (!isOpen) dropdown.classList.add('open');
    });
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

let selectedExtraCam = null;
function populateAddCamOptions(group) {
    const mainCam = cameras[selectedCamIdx];
    const isMeetingBoardPro = mainCam && mainCam.name.toLowerCase() === 'meetingboard pro';

    const filtered = cameras.filter(device => {
        if (device.name.toLowerCase() === 'mb-12x pro') {
            return isMeetingBoardPro;
        }
        if (group === 'avhub') return device.supports_avhub;
        if (group === 'mtower') return device.is_mtower;
        return false;
    });
    
    selectedExtraCam = filtered[0]?.name;
    
    initCustomDropdown('addCamDropdown', 'addCamTrigger', 'addCamScroll', 'addCamText',
        filtered.map(d => ({ label: d.name, value: d.name })),
        (val) => selectedExtraCam = val
    );
}

function renderGenericDeviceList(containerId, array, typeName, onRemove, infoFn) {
    const listEl = document.getElementById(containerId);
    if (!listEl) return;
    listEl.innerHTML = '';
    array.forEach((dev, idx) => {
        const item = document.createElement('div');
        item.className = 'added-cam-item';
        
        const header = document.createElement('div');
        header.className = 'added-cam-header';
        
        const titleWrap = document.createElement('div');
        titleWrap.className = 'added-cam-title';
        titleWrap.innerHTML = `
            <span class="added-cam-badge">${typeName} ${idx + 1}</span>
            <span title="${dev.deviceName}">${dev.deviceName}</span>
            ${infoFn && infoFn(dev) ? `<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">${infoFn(dev)}</div>` : ''}
        `;
        
        if (dev.locked) {
            const lockIcon = document.createElement('div');
            lockIcon.className = 'added-cam-lock';
            lockIcon.title = dev.lockMessage || 'נעול';
            lockIcon.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                </svg>
            `;
            header.appendChild(titleWrap);
            header.appendChild(lockIcon);
        } else {
            const removeBtn = document.createElement('button');
            removeBtn.className = 'added-cam-remove-btn';
            removeBtn.type = 'button';
            removeBtn.title = 'מחק';
            removeBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
            `;
            removeBtn.addEventListener('click', () => onRemove(dev.id));
            header.appendChild(titleWrap);
            header.appendChild(removeBtn);
        }
        item.appendChild(header);
        listEl.appendChild(item);
    });
}

function renderExtraDevicesList() {
    renderGenericDeviceList('addedDisplaysList', extraDisplays, 'מסך', (id) => {
        extraDisplays = extraDisplays.filter(d => d.id !== id);
        renderExtraDevicesList();
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    });
    renderGenericDeviceList('addedMicsList', extraMics, 'מיקרופון', (id) => {
        extraMics = extraMics.filter(d => d.id !== id);
        renderExtraDevicesList();
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    }, (dev) => dev.radius ? `רדיוס: ${dev.radius} מ׳` : '');
    renderGenericDeviceList('addedSpeakersList', extraSpeakers, 'רמקול', (id) => {
        extraSpeakers = extraSpeakers.filter(d => d.id !== id);
        renderExtraDevicesList();
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    }, (dev) => dev.angle ? `זווית: ${dev.angle}°` : '');
    renderGenericDeviceList('addedOthersList', extraOthers, 'מכשיר', (id) => {
        extraOthers = extraOthers.filter(d => d.id !== id);
        renderExtraDevicesList();
        updateChairsAndDraw();
        StateManager.saveCurrentState();
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
                    StateManager.saveCurrentState();
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
                <input type="range" min="0" max="360" value="${ec.rot}" id="ecSldr_${ec.id}">
                <input type="number" class="rot-pill" id="ecPill_${ec.id}" style="font-size: 10.5px; padding: 2px 6px; min-width: 38px; border: none; background: transparent; color: var(--primary); outline: none; text-align: center;" value="${ec.rot}">
            </div>
        `;
        
        const slider = rotField.querySelector('input[type="range"]');
        const pill = rotField.querySelector('.rot-pill');
        slider.addEventListener('input', (e) => {
            ec.rot = parseInt(e.target.value);
            pill.value = ec.rot;
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        });
        pill.addEventListener('input', (e) => {
            let val = parseInt(e.target.value);
            if (isNaN(val)) val = 0;
            ec.rot = val;
            slider.value = val;
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        });
        
        item.appendChild(rotField);
        listEl.appendChild(item);
    });
}

function showDashboard() {
    document.getElementById('dashboardView').style.display = 'block';
    document.getElementById('appBody').style.display = 'none';
    document.getElementById('navDashboardBtn').style.display = 'none';
    document.getElementById('topbarNav').style.display = 'none';
    document.getElementById('undoRedoControls').style.display = 'none';
    document.getElementById('toggleSidebarBtn').style.display = 'none';
    
    // Close all accordions when returning to dashboard
    document.querySelectorAll('.sidebar-accordion').forEach(acc => {
        acc.removeAttribute('open');
    });
    
    renderDashboard();
}

function showAppBody() {
    document.getElementById('dashboardView').style.display = 'none';
    document.getElementById('appBody').style.display = 'flex';
    document.getElementById('navDashboardBtn').style.display = 'block';
    document.getElementById('topbarNav').style.display = 'flex';
    document.getElementById('undoRedoControls').style.display = 'flex';
    // Ensure sidebar is visible and external toggle is hidden when entering app view
    const sidebar = document.getElementById('sidebar');
    sidebar.classList.remove('collapsed');
    document.getElementById('toggleSidebarBtn').style.display = 'none';
    
    syncUIWithState();
    centerRoom();
}


function syncUIWithState() {
    document.getElementById('roomW').value = room.w;
    document.getElementById('roomH').value = room.h;
    document.getElementById('tableW').value = table.w;
    document.getElementById('tableH').value = table.h;
    document.getElementById('tableDist').value = Math.max(0, table.y - table.h / 2).toFixed(2);
    const tsMap = { 'rectangular': 'מלבני (Rectangular)', 'circular': 'עגול (Circular)', 'u-shape': "צורת ח' (U-Shape)" };
    if (document.getElementById('tableShapeText')) {
        document.getElementById('tableShapeText').textContent = tsMap[tableShape] || tsMap['rectangular'];
        document.querySelectorAll('#tableShapeScroll .cam-dd-item').forEach(el => {
            el.classList.toggle('active', el.textContent.includes(tsMap[tableShape]));
        });
    }
    document.getElementById('camRotation').value = cam.rot;
    document.getElementById('rotVal').value = cam.rot;
    
    document.getElementById('multiCamToggle').checked = multiCamEnabled;
    const controls = document.getElementById('multiCamControls');
    if (multiCamEnabled) {
        controls.style.display = 'block';
        populateAddCamOptions(multiCamGroup);
        renderExtraCamsList();
    } else {
        controls.style.display = 'none';
        document.getElementById('addedCamsList').innerHTML = '';
    }
    renderExtraDevicesList();

    updateDropdownDisabledState();

    const currentCam = cameras[selectedCamIdx];
    document.getElementById('camDdText').textContent = currentCam.name;
    const scroll = document.getElementById('camScroll');
    scroll.querySelectorAll('.cam-dd-item').forEach((el, j) => {
        el.classList.toggle('active', j === selectedCamIdx);
    });

    applyLensToMainCam(currentCam, selectedLensIdx);
    renderLensSegment(currentCam, selectedLensIdx, (lensI) => {
        selectedLensIdx = lensI;
        applyLensToMainCam(currentCam, lensI);
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    });

    updateChairsAndDraw();
    resizeCanvas();
}

function renderDashboard() {
    const grid = document.getElementById('projectGrid');
    const cards = grid.querySelectorAll('.project-card:not(#newProjectBtn)');
    cards.forEach(c => c.remove());

    const projects = StateManager.getProjects();
    projects.forEach(p => {
        const card = document.createElement('div');
        card.className = 'project-card';
        card.innerHTML = `
            <div>
                <div class="pc-title">${p.name}</div>
                <div class="pc-meta">נוצר: ${new Date(p.createdAt).toLocaleDateString('he-IL')}</div>
                <div class="pc-meta" style="margin-top:4px;">חדר: ${p.room.w}x${p.room.h} מ׳</div>
            </div>
        `;
        card.addEventListener('click', () => {
            StateManager.loadProject(p.id);
            showAppBody();
        });
        
        const delBtn = document.createElement('button');
        delBtn.innerHTML = '&times;';
        delBtn.style.cssText = 'position: absolute; top: 10px; left: 10px; background: transparent; border: none; font-size: 18px; color: var(--text-3); cursor: pointer;';
        delBtn.onclick = (e) => {
            e.stopPropagation();
            if (confirm('האם אתה בטוח שברצונך למחוק פרויקט זה?')) {
                StateManager.deleteProject(p.id);
                renderDashboard();
            }
        };
        card.style.position = 'relative';
        card.appendChild(delBtn);

        grid.appendChild(card);
    });
}

function init() {
    // Check Theme
    const savedTheme = localStorage.getItem('av_planner_theme');
    if (savedTheme === 'dark') {
        document.body.dataset.theme = 'dark';
        document.querySelector('.sun-icon').style.display = 'none';
        document.querySelector('.moon-icon').style.display = 'block';
    }
    
    document.getElementById('themeToggleBtn').addEventListener('click', () => {
        const isDark = document.body.dataset.theme === 'dark';
        if (isDark) {
            delete document.body.dataset.theme;
            localStorage.setItem('av_planner_theme', 'light');
            document.querySelector('.sun-icon').style.display = 'block';
            document.querySelector('.moon-icon').style.display = 'none';
        } else {
            document.body.dataset.theme = 'dark';
            localStorage.setItem('av_planner_theme', 'dark');
            document.querySelector('.sun-icon').style.display = 'none';
            document.querySelector('.moon-icon').style.display = 'block';
        }
        if (typeof updateChairsAndDraw === 'function') {
            updateChairsAndDraw();
        }
    });

    document.getElementById('navDashboardBtn').addEventListener('click', () => {
        StateManager.setCurrentProjectId(null);
        showDashboard();
    });

    document.getElementById('newProjectBtn').addEventListener('click', () => {
        document.getElementById('newProjectName').value = '';
        document.getElementById('newProjectModal').classList.add('open');
    });

    document.getElementById('closeNewProjectBtn').addEventListener('click', () => {
        document.getElementById('newProjectModal').classList.remove('open');
    });

    // Sidebar collapse logic
    const collapseSidebarInnerBtn = document.getElementById('collapseSidebarInnerBtn');
    const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');
    const sidebarEl = document.getElementById('sidebar');

    function collapseSidebar() {
        sidebarEl.classList.add('collapsed');
        setTimeout(() => {
            if (sidebarEl.classList.contains('collapsed')) {
                toggleSidebarBtn.style.display = 'flex'; // make element block
                // force reflow
                toggleSidebarBtn.offsetHeight;
                toggleSidebarBtn.classList.add('visible'); // slide in
            }
        }, 300);
    }
    function expandSidebar() {
        toggleSidebarBtn.classList.remove('visible'); // slide out
        sidebarEl.classList.remove('collapsed'); // start opening sidebar immediately
        setTimeout(() => {
            if (!sidebarEl.classList.contains('collapsed')) {
                toggleSidebarBtn.style.display = 'none'; // hide after animation
            }
        }, 300);
    }

    collapseSidebarInnerBtn.addEventListener('click', collapseSidebar);
    toggleSidebarBtn.addEventListener('click', expandSidebar);

    // Custom exclusive accordion logic (avoids Chrome name="sidebar" glitch)
    const accordions = document.querySelectorAll('.sidebar-accordion');
    accordions.forEach(acc => {
        acc.addEventListener('toggle', (e) => {
            if (acc.open) {
                accordions.forEach(otherAcc => {
                    if (otherAcc !== acc && otherAcc.open) {
                        otherAcc.removeAttribute('open');
                    }
                });
            }
        });
    });

    document.getElementById('createNewProjectOkBtn').addEventListener('click', () => {
        const name = document.getElementById('newProjectName').value.trim() || 'פרויקט חדש';
        const p = StateManager.createProject(name);
        StateManager.loadProject(p.id);
        document.getElementById('newProjectModal').classList.remove('open');
        showAppBody();
    });

    buildDropdown();

    rotSlider.addEventListener('input', (e) => {
        cam.rot = parseInt(e.target.value);
        rotVal.value = cam.rot;
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    });

    rotVal.addEventListener('input', (e) => {
        let val = parseInt(e.target.value);
        if (isNaN(val)) val = 0;
        cam.rot = val;
        rotSlider.value = val;
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    });

    document.querySelectorAll('#fovDisplaySegment .segment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#fovDisplaySegment .segment-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            fovDisplayMode = btn.dataset.val;
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        });
    });
    
    document.querySelectorAll('#micDisplaySegment .segment-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('#micDisplaySegment .segment-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            micDisplayMode = btn.dataset.val;
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        });
    });

    const projectNameDisplayWrap = document.getElementById('projectNameDisplayWrap');
    const renameProjectModal = document.getElementById('renameProjectModal');
    const renameProjectNameInput = document.getElementById('renameProjectNameInput');
    const closeRenameProjectBtn = document.getElementById('closeRenameProjectBtn');
    const renameProjectOkBtn = document.getElementById('renameProjectOkBtn');
    const projectNameDisplay = document.getElementById('projectNameDisplay');

    if (projectNameDisplayWrap && renameProjectModal) {
        projectNameDisplayWrap.addEventListener('click', () => {
            const currentId = StateManager.getCurrentProjectId();
            if (currentId) {
                const projects = StateManager.getProjects();
                const p = projects.find(p => p.id === currentId);
                if (p) {
                    renameProjectNameInput.value = p.name;
                    renameProjectModal.classList.add('open');
                }
            }
        });

        closeRenameProjectBtn.addEventListener('click', () => {
            renameProjectModal.classList.remove('open');
        });

        renameProjectOkBtn.addEventListener('click', () => {
            const currentId = StateManager.getCurrentProjectId();
            if (currentId) {
                const projects = StateManager.getProjects();
                const p = projects.find(p => p.id === currentId);
                if (p) {
                    p.name = renameProjectNameInput.value.trim() || 'פרויקט ללא שם';
                    StateManager.saveProjects(projects);
                    if (projectNameDisplay) projectNameDisplay.textContent = p.name;
                    renameProjectModal.classList.remove('open');
                }
            }
        });
    }

    ['roomW', 'roomH', 'tableW', 'tableH', 'tableDist', 'tableSeats'].forEach(id => {
        document.getElementById(id).addEventListener('input', readInputs);
    });

    initCustomDropdown('tableShapeDropdown', 'tableShapeTrigger', 'tableShapeScroll', 'tableShapeText', [
        { label: 'מלבני (Rectangular)', value: 'rectangular' },
        { label: 'עגול (Circular)', value: 'circular' },
        { label: 'צורת ח\' (U-Shape)', value: 'u-shape' }
    ], (val) => {
        tableShape = val;
        updateChairsAndDraw();
        StateManager.saveCurrentState();
    }, tableShape);

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
                
                // Add AVHub to extraOthers if not already present
                if (!extraOthers.some(d => d.id === 'auto-avhub')) {
                    extraOthers.push({
                        id: 'auto-avhub',
                        deviceName: 'AVHub',
                        locked: true,
                        lockMessage: 'נוסף אוטומטית עקב בחירה במצב ריבוי מצלמות. לא ניתן למחיקה.'
                    });
                    renderExtraDevicesList();
                }
                
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
            extraOthers = extraOthers.filter(d => d.id !== 'auto-avhub');
            renderExtraDevicesList();
            updateDropdownDisabledState();
            renderExtraCamsList();
            updateChairsAndDraw();
        }
        StateManager.saveCurrentState();
    });

    addBtn.addEventListener('click', () => {
        if (!multiCamEnabled) return;
        if (extraCams.length >= 3) {
            showCustomAlert("ניתן להוסיף עד 3 מצלמות נוספות בלבד.");
            return;
        }
        const camName = selectedExtraCam;
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
            StateManager.saveCurrentState();
        }
    });

    let selectedDisplay = window.availableDisplays[0]?.name;
    initCustomDropdown('displayDropdown', 'displayTrigger', 'displayScroll', 'displayText',
        window.availableDisplays.map(d => ({ label: d.name, value: d.name })),
        (val) => selectedDisplay = val
    );

    let selectedMic = window.availableMics[0]?.name;
    initCustomDropdown('micDropdown', 'micTrigger', 'micScroll', 'micText',
        window.availableMics.map(d => ({ label: d.name, value: d.name })),
        (val) => selectedMic = val
    );

    let selectedSpeaker = window.availableSpeakers[0]?.name;
    initCustomDropdown('speakerDropdown', 'speakerTrigger', 'speakerScroll', 'speakerText',
        window.availableSpeakers.map(d => ({ label: d.name, value: d.name })),
        (val) => selectedSpeaker = val
    );

    let selectedOther = window.availableOthers[0]?.name;
    initCustomDropdown('otherDropdown', 'otherTrigger', 'otherScroll', 'otherText',
        window.availableOthers.map(d => ({ label: d.name, value: d.name })),
        (val) => selectedOther = val
    );

    document.getElementById('addDisplayBtn').addEventListener('click', () => {
        const name = selectedDisplay;
        const device = window.availableDisplays.find(d => d.name === name);
        if (device) {
            extraDisplays.push({
                id: ++lastExtraCamId,
                deviceName: device.name,
                width: parseDisplaySize(device.name),
                rot: 0,
                x: room.w / 2 + (extraDisplays.length - 1) * 0.4,
                y: 0.1
            });
            renderExtraDevicesList();
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        }
    });

    document.getElementById('addOtherBtn').addEventListener('click', () => {
        const name = selectedOther;
        const device = window.availableOthers.find(d => d.name === name);
        if (device) {
            extraOthers.push({
                id: ++lastExtraCamId,
                deviceName: device.name
            });
            renderExtraDevicesList();
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        }
    });

    document.getElementById('addMicBtn').addEventListener('click', () => {
        const name = selectedMic;
        const device = window.availableMics.find(d => d.name === name);
        if (device) {
            extraMics.push({
                id: ++lastExtraCamId,
                deviceName: device.name,
                radius: parseRadius(device.pickup_range),
                rot: 0,
                x: table.x,
                y: table.y + (extraMics.length * 0.5)
            });
            renderExtraDevicesList();
            updateChairsAndDraw();
            StateManager.saveCurrentState();
        }
    });

    document.getElementById('addSpeakerBtn').addEventListener('click', () => {
        const name = selectedSpeaker;
        const device = window.availableSpeakers.find(d => d.name === name);
        if (device) {
            extraSpeakers.push({
                id: ++lastExtraCamId,
                deviceName: device.name,
                angle: parseAngle(device.coverage_angle) || 120,
                rot: 90,
                x: room.w / 2 + (extraSpeakers.length * 0.5),
                y: 0.1
            });
            renderExtraDevicesList();
            updateChairsAndDraw();
            StateManager.saveCurrentState();
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
    
    document.addEventListener('keydown', (e) => {
        // Undo / Redo
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
            if (e.shiftKey) StateManager.redo();
            else StateManager.undo();
            e.preventDefault();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
            StateManager.redo();
            e.preventDefault();
            return;
        }

        if (e.key === 'Backspace' || e.key === 'Delete') {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            if (selectedObject && typeof selectedObject === 'object') {
                if (selectedObject.type === 'extraCam') {
                    extraCams = extraCams.filter(c => c.id !== selectedObject.id);
                    renderExtraCamsList();
                } else if (selectedObject.type === 'extraDisplay') {
                    extraDisplays = extraDisplays.filter(c => c.id !== selectedObject.id);
                    renderExtraDevicesList();
                } else if (selectedObject.type === 'extraSpeaker') {
                    extraSpeakers = extraSpeakers.filter(c => c.id !== selectedObject.id);
                    renderExtraDevicesList();
                } else if (selectedObject.type === 'extraMic') {
                    extraMics = extraMics.filter(c => c.id !== selectedObject.id);
                    renderExtraDevicesList();
                }
                selectedObject = null;
                updateChairsAndDraw();
                StateManager.saveCurrentState();
            }
        }
    });
    
    // Wheel Zoom Event
    canvas.addEventListener('wheel', onWheel, { passive: false });

    // Controls
    document.getElementById('btnZoomIn').addEventListener('click', () => zoomBy(1.2));
    document.getElementById('btnZoomOut').addEventListener('click', () => zoomBy(1 / 1.2));
    document.getElementById('btnResetView').addEventListener('click', centerRoom);
    
    const btnUndo = document.getElementById('btnUndo');
    if (btnUndo) btnUndo.addEventListener('click', () => StateManager.undo());
    
    const btnRedo = document.getElementById('btnRedo');
    if (btnRedo) btnRedo.addEventListener('click', () => StateManager.redo());

    updateUndoRedoUI();

    const currentId = StateManager.getCurrentProjectId();
    if (currentId && StateManager.loadProject(currentId)) {
        showAppBody();
    } else {
        showDashboard();
    }
}

function updateUndoRedoUI() {
    const btnUndo = document.getElementById('btnUndo');
    const btnRedo = document.getElementById('btnRedo');
    if (btnUndo) {
        btnUndo.disabled = undoStack.length <= 1;
        btnUndo.style.opacity = undoStack.length <= 1 ? '0.3' : '1';
        btnUndo.style.pointerEvents = undoStack.length <= 1 ? 'none' : 'auto';
    }
    if (btnRedo) {
        btnRedo.disabled = redoStack.length === 0;
        btnRedo.style.opacity = redoStack.length === 0 ? '0.3' : '1';
        btnRedo.style.pointerEvents = redoStack.length === 0 ? 'none' : 'auto';
    }
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

    if (document.getElementById('roomDimDisplay')) document.getElementById('roomDimDisplay').innerText = `${room.w} × ${room.h} מ׳`;
    if (document.getElementById('tableDimDisplay')) document.getElementById('tableDimDisplay').innerText = `${table.w} × ${table.h} מ׳`;

    updateChairsAndDraw();
    StateManager.saveCurrentState();
}

function generateChairs() {
    chairs = [];
    const chairSpacing = 0.65;
    const manualSeatsInput = document.getElementById('tableSeats');
    const manualSeats = manualSeatsInput ? parseInt(manualSeatsInput.value) : NaN;
    
    if (tableShape === 'rectangular') {
        let sideChairsCount;
        let hasBottomChair = true;
        
        if (!isNaN(manualSeats) && manualSeats > 0) {
            if (manualSeats % 2 === 0) {
                sideChairsCount = manualSeats / 2;
                hasBottomChair = false;
            } else {
                sideChairsCount = Math.floor(manualSeats / 2);
                hasBottomChair = true;
            }
        } else {
            sideChairsCount = Math.max(1, Math.floor(table.h / chairSpacing));
            hasBottomChair = true;
        }

        const currentSpacing = sideChairsCount > 0 ? table.h / sideChairsCount : chairSpacing;
        const startY = (table.y - table.h / 2) + currentSpacing / 2;
        
        for (let i = 0; i < sideChairsCount; i++) {
            let cy = startY + i * currentSpacing;
            chairs.push({ x: table.x - table.w / 2 - 0.25, y: cy, angle: 0 });
            chairs.push({ x: table.x + table.w / 2 + 0.25, y: cy, angle: 180 });
        }
        
        if (hasBottomChair && manualSeats !== 0) {
            chairs.push({ x: table.x, y: table.y + table.h / 2 + 0.25, angle: 270 });
        }
    } 
    else if (tableShape === 'circular') {
        const a = table.w / 2;
        const b = table.h / 2;
        let count;
        
        if (!isNaN(manualSeats) && manualSeats > 0) {
            count = manualSeats;
        } else {
            // Approx perimeter of ellipse
            const h_approx = Math.pow(a - b, 2) / Math.pow(a + b, 2);
            const perimeter = Math.PI * (a + b) * (1 + (3 * h_approx) / (10 + Math.sqrt(4 - 3 * h_approx)));
            count = Math.max(1, Math.floor(perimeter / chairSpacing));
        }

        for (let i = 0; i < count; i++) {
            const angleRad = (i / count) * Math.PI * 2;
            const cx = table.x + (a + 0.25) * Math.cos(angleRad);
            const cy = table.y + (b + 0.25) * Math.sin(angleRad);
            // Normal angle for ellipse
            const normalAngleRad = Math.atan2(a * Math.sin(angleRad), b * Math.cos(angleRad));
            chairs.push({ x: cx, y: cy, angle: (normalAngleRad * 180 / Math.PI + 180) % 360 });
        }
    } 
    else if (tableShape === 'u-shape') {
        let sideChairsCount, bottomChairsCount;
        
        if (!isNaN(manualSeats) && manualSeats > 0) {
            const totalLen = 2 * table.h + table.w;
            sideChairsCount = Math.round((table.h / totalLen) * manualSeats);
            bottomChairsCount = manualSeats - 2 * sideChairsCount;
            if (bottomChairsCount < 0) {
                bottomChairsCount = 0;
                sideChairsCount = Math.floor(manualSeats / 2);
            }
        } else {
            sideChairsCount = Math.max(1, Math.floor(table.h / chairSpacing));
            bottomChairsCount = Math.max(1, Math.floor(table.w / chairSpacing));
        }

        const sideSpacing = sideChairsCount > 0 ? table.h / sideChairsCount : chairSpacing;
        const bottomSpacing = bottomChairsCount > 0 ? table.w / bottomChairsCount : chairSpacing;

        const startY = (table.y - table.h / 2) + sideSpacing / 2;
        for (let i = 0; i < sideChairsCount; i++) {
            chairs.push({ x: table.x - table.w / 2 - 0.25, y: startY + i * sideSpacing, angle: 0 });
            chairs.push({ x: table.x + table.w / 2 + 0.25, y: startY + i * sideSpacing, angle: 180 });
        }
        
        const startX = (table.x - table.w / 2) + bottomSpacing / 2;
        for (let i = 0; i < bottomChairsCount; i++) {
            chairs.push({ x: startX + i * bottomSpacing, y: table.y + table.h / 2 + 0.25, angle: 270 });
        }
    } 
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

function checkMicCoverage(px, py) {
    let hasMics = false;
    let covered = false;

    // Check main camera mic
    if (cam.audioRadius) {
        hasMics = true;
        let dist = Math.hypot(px - cam.x, py - cam.y);
        if (dist <= cam.audioRadius) covered = true;
    }

    // Check extra cams mics
    if (multiCamEnabled) {
        extraCams.forEach(ec => {
            if (ec.audioRadius) {
                hasMics = true;
                let dist = Math.hypot(px - ec.x, py - ec.y);
                if (dist <= ec.audioRadius) covered = true;
            }
        });
    }

    // Check extra mics
    extraMics.forEach(m => {
        let r = parseAudio(m.pickup_radius) || 0;
        if (r > 0) {
            hasMics = true;
            let dist = Math.hypot(px - m.x, py - m.y);
            if (dist <= r) covered = true;
        }
    });

    return { hasMics, covered };
}

function updateChairsAndDraw() {
    generateChairs();

    if (multiCamEnabled) {
        extraCams.forEach(ec => {
            if (ec.deviceName && ec.deviceName.toLowerCase() === 'mb-12x pro') {
                ec.x = cam.x;
                ec.y = cam.y;
                ec.rot = cam.rot;
            }
        });
    }

    let insideCamCount = 0;
    let insideMicCount = 0;
    let hasMics = false;

    chairs.forEach(c => {
        c.inside = checkFovCoverage(c.x, c.y);
        if (c.inside) insideCamCount++;
        
        let micCheck = checkMicCoverage(c.x, c.y);
        if (micCheck.hasMics) hasMics = true;
        if (micCheck.covered) insideMicCount++;
    });

    const camPct = chairs.length > 0 ? Math.round((insideCamCount / chairs.length) * 100) : 0;
    const micPct = chairs.length > 0 ? Math.round((insideMicCount / chairs.length) * 100) : 0;

    const circ = 169.6;
    
    // Update Camera Ring
    const camRing = document.getElementById('camCoverageRing');
    const camLabel = document.getElementById('camRingLabel');
    if (camRing && camLabel) {
        camLabel.innerText = `${camPct}%`;
        camRing.style.strokeDashoffset = circ * (1 - camPct / 100);
        if (camPct === 100) camRing.style.stroke = '#10b981';
        else if (camPct >= 60) camRing.style.stroke = '#0ea5e9';
        else camRing.style.stroke = '#ef4444';
    }

    // Update Mic Ring
    const micRing = document.getElementById('micCoverageRing');
    const micLabel = document.getElementById('micRingLabel');
    if (micRing && micLabel) {
        if (!hasMics) {
            micLabel.innerHTML = `<span style="color: var(--text-muted);">-</span>`;
            micRing.style.strokeDashoffset = circ;
        } else {
            micLabel.innerText = `${micPct}%`;
            micRing.style.strokeDashoffset = circ * (1 - micPct / 100);
            if (micPct === 100) micRing.style.stroke = '#10b981';
            else if (micPct >= 60) micRing.style.stroke = '#f59e0b';
            else micRing.style.stroke = '#ef4444';
        }
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

    if (e.ctrlKey) {
        // Pinch-to-zoom on trackpad or Ctrl + Mouse Wheel
        const zoomIntensity = 0.005;
        const delta = -e.deltaY * zoomIntensity;
        let newScale = scale * Math.exp(delta);
        newScale = Math.max(0.2, Math.min(newScale, 5));

        const wx = (mx - RULER - offsetX) / (PPM * scale);
        const wy = (my - RULER - offsetY) / (PPM * scale);

        offsetX = mx - RULER - wx * PPM * newScale;
        offsetY = my - RULER - wy * PPM * newScale;
        scale = newScale;
        updateZoomDisplay();
    } else {
        // Two-finger swipe to pan
        offsetX -= e.deltaX;
        offsetY -= e.deltaY;
    }

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
            if (ec.deviceName && ec.deviceName.toLowerCase() === 'mb-12x pro') continue;
            
            const ecPx = RULER + offsetX + ec.x * PPM * scale;
            const ecPy = RULER + offsetY + ec.y * PPM * scale;
            if (Math.hypot(mx - ecPx, my - ecPy) < 25) {
                dragTarget = { type: 'extraCam', id: ec.id };
                selectedObject = dragTarget;
                canvas.setPointerCapture(e.pointerId);
                draw();
                return;
            }
        }
    }

    const extraTypes = [
        { arr: extraMics, type: 'extraMic' },
        { arr: extraSpeakers, type: 'extraSpeaker' },
        { arr: extraDisplays, type: 'extraDisplay' }
    ];
    for (const t of extraTypes) {
        for (let i = 0; i < t.arr.length; i++) {
            const dev = t.arr[i];
            const px = RULER + offsetX + dev.x * PPM * scale;
            const py = RULER + offsetY + dev.y * PPM * scale;
            
            let isHit = false;
            if (t.type === 'extraDisplay') {
                const angle = -(dev.rot || 0) * Math.PI / 180;
                const dx = mx - px;
                const dy = my - py;
                const lx = dx * Math.cos(angle) - dy * Math.sin(angle);
                const ly = dx * Math.sin(angle) + dy * Math.cos(angle);
                const w = (dev.width || 1) * PPM * scale;
                const h = 0.05 * PPM * scale;
                // Add 15px padding for easier grabbing
                if (Math.abs(lx) <= w/2 + 15 && Math.abs(ly) <= h/2 + 15) {
                    isHit = true;
                }
            } else {
                if (Math.hypot(mx - px, my - py) < 25) {
                    isHit = true;
                }
            }

            if (isHit) {
                dragTarget = { type: t.type, id: dev.id };
                selectedObject = dragTarget;
                canvas.setPointerCapture(e.pointerId);
                draw();
                return;
            }
        }
    }

    const camPx = RULER + offsetX + cam.x * PPM * scale;
    const camPy = RULER + offsetY + cam.y * PPM * scale;

    if (selectedObject === 'cam') {
        const handleAngle = (cam.rot - 45) * Math.PI / 180;
        const hx = camPx + Math.cos(handleAngle) * 48;
        const hy = camPy + Math.sin(handleAngle) * 48;
        if (Math.hypot(mx - hx, my - hy) < 15) {
            dragTarget = { type: 'rotate-cam', target: 'cam' };
            canvas.setPointerCapture(e.pointerId);
            return;
        }
    } else if (selectedObject && typeof selectedObject === 'object') {
        let dev = null;
        if (selectedObject.type === 'extraCam') dev = extraCams.find(c => c.id === selectedObject.id);
        
        
        if (dev) {
            const px = RULER + offsetX + dev.x * PPM * scale;
            const py = RULER + offsetY + dev.y * PPM * scale;
            const handleAngle = ((dev.rot || 0) - 45) * Math.PI / 180;
            const hx = px + Math.cos(handleAngle) * 48;
            const hy = py + Math.sin(handleAngle) * 48;
            if (Math.hypot(mx - hx, my - hy) < 15) {
                dragTarget = { type: 'rotate-cam', target: selectedObject };
                canvas.setPointerCapture(e.pointerId);
                return;
            }
        }
    }

    if (Math.hypot(mx - camPx, my - camPy) < 25) {
        dragTarget = 'cam';
        selectedObject = 'cam';
        canvas.setPointerCapture(e.pointerId);
        draw();
        return;
    }

    const tX = RULER + offsetX + table.x * PPM * scale;
    const tY = RULER + offsetY + table.y * PPM * scale;
    const tW = table.w * PPM * scale;
    const tH = table.h * PPM * scale;
    
    if (selectedObject === 'table') {
        const hSize = 8;
        const corners = [
            { id: 'tl', x: tX - tW/2, y: tY - tH/2 },
            { id: 'tr', x: tX + tW/2, y: tY - tH/2 },
            { id: 'bl', x: tX - tW/2, y: tY + tH/2 },
            { id: 'br', x: tX + tW/2, y: tY + tH/2 }
        ];
        for (let c of corners) {
            if (Math.hypot(mx - c.x, my - c.y) < hSize) {
                dragTarget = { type: 'resize', corner: c.id };
                canvas.setPointerCapture(e.pointerId);
                return;
            }
        }
    }

    if (mx > tX - tW / 2 && mx < tX + tW / 2 && my > tY - tH / 2 && my < tY + tH / 2) {
        dragTarget = 'table';
        selectedObject = 'table';
        dragOffset.x = wx - table.x;
        dragOffset.y = wy - table.y;
        canvas.setPointerCapture(e.pointerId);
        draw();
        return;
    }

    selectedObject = null;
    draw();
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
            if (ec.deviceName && ec.deviceName.toLowerCase() === 'mb-12x pro') continue;
            
            const ecPx = RULER + offsetX + ec.x * PPM * scale;
            const ecPy = RULER + offsetY + ec.y * PPM * scale;
            if (Math.hypot(mx - ecPx, my - ecPy) < 25) {
                hoverTarget = 'extraCam';
                break;
            }
        }
    }
    const extraTypes = [
        { arr: extraMics, type: 'extraMic' },
        { arr: extraSpeakers, type: 'extraSpeaker' },
        { arr: extraDisplays, type: 'extraDisplay' }
    ];
    for (const t of extraTypes) {
        for (let i = 0; i < t.arr.length; i++) {
            const dev = t.arr[i];
            const px = RULER + offsetX + dev.x * PPM * scale;
            const py = RULER + offsetY + dev.y * PPM * scale;
            
            let isHit = false;
            if (t.type === 'extraDisplay') {
                const angle = -(dev.rot || 0) * Math.PI / 180;
                const distx = mx - px;
                const disty = my - py;
                const lx = distx * Math.cos(angle) - disty * Math.sin(angle);
                const ly = distx * Math.sin(angle) + disty * Math.cos(angle);
                const w = (dev.width || 1) * PPM * scale;
                const h = 0.05 * PPM * scale;
                if (Math.abs(lx) <= w/2 + 15 && Math.abs(ly) <= h/2 + 15) {
                    isHit = true;
                }
            } else {
                if (Math.hypot(mx - px, my - py) < 25) {
                    isHit = true;
                }
            }
            if (isHit) {
                hoverTarget = t.type;
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

    isSnappedX = false;
    isSnappedY = false;

    if (dragTarget && dragTarget.type === 'rotate-cam') {
        let targetDev = null;
        if (dragTarget.target === 'cam') {
            targetDev = cam;
        } else if (dragTarget.target.type === 'extraCam') {
            targetDev = extraCams.find(c => c.id === dragTarget.target.id);
        } else if (dragTarget.target.type === 'extraDisplay') {
            targetDev = extraDisplays.find(c => c.id === dragTarget.target.id);
        } else if (dragTarget.target.type === 'extraSpeaker') {
            targetDev = extraSpeakers.find(c => c.id === dragTarget.target.id);
        }
        if (targetDev) {
            const cx = RULER + offsetX + targetDev.x * PPM * scale;
            const cy = RULER + offsetY + targetDev.y * PPM * scale;
            const angleRad = Math.atan2(my - cy, mx - cx);
            let angleDeg = Math.round(angleRad * 180 / Math.PI + 45);
            angleDeg = (angleDeg % 360 + 360) % 360;
            
            const snapThreshold = 12;
            for (let snap of [0, 90, 180, 270, 360]) {
                if (Math.abs(angleDeg - snap) <= snapThreshold || Math.abs(angleDeg - snap) >= 360 - snapThreshold) {
                    angleDeg = snap % 360;
                    break;
                }
            }
            
            targetDev.rot = angleDeg;

            if (dragTarget.target === 'cam') {
                document.getElementById('camRotation').value = angleDeg;
                document.getElementById('rotVal').value = angleDeg;
                cam.rot = angleDeg;
                updateCamProps();
            } else if (dragTarget.target.type === 'extraCam') {
                const sldr = document.getElementById('ecSldr_' + targetDev.id);
                const pill = document.getElementById('ecPill_' + targetDev.id);
                if (sldr) sldr.value = angleDeg;
                if (pill) pill.value = angleDeg;
            }
            updateChairsAndDraw();
        }
        return;
    }

    if (dragTarget === 'cam') {
        let nx = Math.max(0, Math.min(room.w, wx));
        let ny = Math.max(0, Math.min(room.h, wy));
        if (Math.abs(nx - room.w / 2) < 0.15) { nx = room.w / 2; isSnappedX = true; }
        if (Math.abs(ny - room.h / 2) < 0.15) { ny = room.h / 2; isSnappedY = true; }
        cam.x = nx;
        cam.y = ny;
    } else if (typeof dragTarget === 'object' && dragTarget.type === 'extraCam') {
        const ec = extraCams.find(c => c.id === dragTarget.id);
        if (ec) {
            let nx = Math.max(0, Math.min(room.w, wx));
            let ny = Math.max(0, Math.min(room.h, wy));
            if (Math.abs(nx - room.w / 2) < 0.15) { nx = room.w / 2; isSnappedX = true; }
            if (Math.abs(ny - room.h / 2) < 0.15) { ny = room.h / 2; isSnappedY = true; }
            ec.x = nx;
            ec.y = ny;
        }
    } else if (typeof dragTarget === 'object' && dragTarget.type === 'extraMic') {
        const em = extraMics.find(c => c.id === dragTarget.id);
        if (em) {
            let nx = Math.max(0, Math.min(room.w, wx));
            let ny = Math.max(0, Math.min(room.h, wy));
            if (Math.abs(nx - room.w / 2) < 0.15) { nx = room.w / 2; isSnappedX = true; }
            if (Math.abs(ny - room.h / 2) < 0.15) { ny = room.h / 2; isSnappedY = true; }
            em.x = nx;
            em.y = ny;
        }
    } else if (typeof dragTarget === 'object' && dragTarget.type === 'extraSpeaker') {
        const es = extraSpeakers.find(c => c.id === dragTarget.id);
        if (es) {
            let nx = Math.max(0, Math.min(room.w, wx));
            let ny = Math.max(0, Math.min(room.h, wy));
            if (Math.abs(nx - room.w / 2) < 0.15) { nx = room.w / 2; isSnappedX = true; }
            if (Math.abs(ny - room.h / 2) < 0.15) { ny = room.h / 2; isSnappedY = true; }
            es.x = nx;
            es.y = ny;
        }
    } else if (typeof dragTarget === 'object' && dragTarget.type === 'extraDisplay') {
        const ed = extraDisplays.find(c => c.id === dragTarget.id);
        if (ed) {
            let nx = Math.max(0, Math.min(room.w, wx));
            let ny = Math.max(0, Math.min(room.h, wy));
            if (Math.abs(nx - room.w / 2) < 0.15) { nx = room.w / 2; isSnappedX = true; }
            
            if (wy < 0.5) ny = 0.1; 
            else if (wy > room.h - 0.5) ny = room.h - 0.1;
            else if (Math.abs(ny - room.h / 2) < 0.15) { ny = room.h / 2; isSnappedY = true; }
            
            ed.x = nx;
            ed.y = ny;
        }
    } else if (dragTarget === 'table') {
        let nx = Math.max(table.w / 2, Math.min(room.w - table.w / 2, wx - dragOffset.x));
        let ny = Math.max(table.h / 2, Math.min(room.h - table.h / 2, wy - dragOffset.y));
        
        if (Math.abs(nx - room.w / 2) < 0.15) { nx = room.w / 2; isSnappedX = true; }
        if (Math.abs(ny - room.h / 2) < 0.15) { ny = room.h / 2; isSnappedY = true; }
        
        table.x = nx;
        table.y = ny;
        document.getElementById('tableDist').value = Math.max(0, table.y - table.h / 2).toFixed(2);
    } else if (typeof dragTarget === 'object' && dragTarget.type === 'resize') {
        const minW = 0.5;
        const minH = 0.5;
        let newW = table.w;
        let newH = table.h;
        let newX = table.x;
        let newY = table.y;

        if (dragTarget.corner.includes('l')) {
            const rightEdge = table.x + table.w/2;
            newW = Math.max(minW, rightEdge - wx);
            newX = rightEdge - newW/2;
        } else if (dragTarget.corner.includes('r')) {
            const leftEdge = table.x - table.w/2;
            newW = Math.max(minW, wx - leftEdge);
            newX = leftEdge + newW/2;
        }
        
        if (dragTarget.corner.includes('t')) {
            const bottomEdge = table.y + table.h/2;
            newH = Math.max(minH, bottomEdge - wy);
            newY = bottomEdge - newH/2;
        } else if (dragTarget.corner.includes('b')) {
            const topEdge = table.y - table.h/2;
            newH = Math.max(minH, wy - topEdge);
            newY = topEdge + newH/2;
        }

        table.w = newW;
        table.h = newH;
        table.x = newX;
        table.y = newY;
        
        document.getElementById('tableW').value = table.w.toFixed(1);
        document.getElementById('tableH').value = table.h.toFixed(1);
        document.getElementById('tableDist').value = Math.max(0, table.y - table.h / 2).toFixed(2);
    }
    updateChairsAndDraw();
}

function onPointerUp(e) {
    isPanning = false;
    if (dragTarget) {
        canvas.releasePointerCapture(e.pointerId);
        dragTarget = null;
        StateManager.saveCurrentState();
    }
    isSnappedX = false;
    isSnappedY = false;
    draw();
}

/* ─── RENDER ─── */
function draw() {
    ctx.fillStyle = '#1C1C1E';
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

    // Draw Room FILL (background) first — before devices
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    ctx.fillRect(0, 0, room.w * PPM, room.h * PPM);

    // Draw solid Room Outline before devices so devices sit on top
    ctx.strokeStyle = '#8A8A8E';
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeRect(0, 0, room.w * PPM, room.h * PPM);

    // Draw dashed white border
    const bOff = 1 / scale;
    ctx.strokeStyle = 'rgba(255,255,255,0.30)';
    ctx.lineWidth = 1.5 / scale;
    ctx.setLineDash([6 / scale, 5 / scale]);
    ctx.strokeRect(-bOff, -bOff, room.w * PPM + bOff * 2, room.h * PPM + bOff * 2);
    ctx.setLineDash([]);



    drawFOV();
    drawTableAndChairs();
    
    ctx.restore();

    // Draw dimension lines BEFORE devices so devices hide the lines beneath them
    drawRoomDimensions();

    // Setup world context again to draw devices on top
    ctx.save();
    ctx.rect(RULER, RULER, canvas.width - RULER, canvas.height - RULER);
    ctx.clip();
    ctx.translate(RULER + offsetX, RULER + offsetY);
    ctx.scale(scale, scale);

    drawDisplays();
    drawSpeakers();
    drawMics();
    drawCamera();

    if (isSnappedX) {
        ctx.strokeStyle = 'rgba(234,179,8,0.8)';
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([8 / scale, 4 / scale]);
        ctx.beginPath();
        ctx.moveTo(room.w/2 * PPM, 0);
        ctx.lineTo(room.w/2 * PPM, room.h * PPM);
        ctx.stroke();
        ctx.setLineDash([]);
    }
    if (isSnappedY) {
        ctx.strokeStyle = 'rgba(234,179,8,0.8)';
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([8 / scale, 4 / scale]);
        ctx.beginPath();
        ctx.moveTo(0, room.h/2 * PPM);
        ctx.lineTo(room.w * PPM, room.h/2 * PPM);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    ctx.restore();
}

function drawGrid(minX, maxX, minY, maxY) {
    ctx.save();
    ctx.rect(RULER, RULER, canvas.width - RULER, canvas.height - RULER);
    ctx.clip();

    const color5 = 'rgba(255,255,255,0.03)';
    const color10 = 'rgba(255,255,255,0.06)';

    // 0.5m lines
    ctx.strokeStyle = color5;
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
    ctx.strokeStyle = color10;
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

function drawRoomDimensions() {
    const lineColor = '#8A8A8E';
    const textColor = '#8A8A8E';
    
    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.fillStyle = textColor;
    ctx.lineWidth = 1.5;
    ctx.font = '12px Heebo, sans-serif';
    ctx.textBaseline = 'middle';
    
    const startX = offsetX;
    const startY = offsetY;
    const endX = offsetX + room.w * PPM * scale;
    const endY = offsetY + room.h * PPM * scale;

    // Room Outline is now drawn in draw() before devices so they sit on top

    // Top Dimension Arrow (X)
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX + 15, startY);
    ctx.stroke();
    
    // X Arrowhead
    ctx.beginPath();
    ctx.moveTo(endX + 15, startY);
    ctx.lineTo(endX + 8, startY - 4);
    ctx.lineTo(endX + 8, startY + 4);
    ctx.fill();
    
    // X Text (e.g. X(8.0m))
    ctx.textAlign = 'left';
    ctx.fillText(`X(${(room.w).toFixed(1)}m)`, endX + 18, startY);

    // Left Dimension Arrow (Y)
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(startX, endY + 15);
    ctx.stroke();
    
    // Y Arrowhead
    ctx.beginPath();
    ctx.moveTo(startX, endY + 15);
    ctx.lineTo(startX - 4, endY + 8);
    ctx.lineTo(startX + 4, endY + 8);
    ctx.fill();
    
    // Y Text (e.g. Y(6.0m))
    ctx.textAlign = 'center';
    ctx.fillText(`Y(${(room.h).toFixed(1)}m)`, startX, endY + 28);
    
    ctx.restore();
}

function drawSingleCamFOV(c) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;
    const rDefault = 2000;
    const angleRad = (c.rot * Math.PI) / 180;
    const fovRad = (c.hfov * Math.PI) / 180;
    const startAngle = angleRad - fovRad / 2;
    const endAngle = angleRad + fovRad / 2;

    if (c.audioRadius && micDisplayMode !== 'hidden') {
        const ar = c.audioRadius * PPM;
        ctx.beginPath();
        
        const arcStart = angleRad - Math.PI/2;
        const arcEnd = angleRad + Math.PI/2;
        
        ctx.arc(cx, cy, ar, arcStart, arcEnd);
        ctx.closePath();
        
        if (micDisplayMode === 'fill') {
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, ar);
            grad.addColorStop(0, 'rgba(245, 158, 11, 0.15)');
            grad.addColorStop(1, 'rgba(245, 158, 11, 0)');
            ctx.fillStyle = grad;
            ctx.fill();
        }
        
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.5)';
        ctx.lineWidth = 1.5 / scale;
        ctx.setLineDash([8 / scale, 6 / scale]);
        ctx.stroke();
        ctx.setLineDash([]);
    }

    if (fovDisplayMode !== 'hidden') {
        if (c.dofMax && fovDisplayMode === 'fill') {
            const dofMaxPx = c.dofMax === Infinity ? 30 * PPM : c.dofMax * PPM; 
            const visualMax = Math.min(dofMaxPx, 30 * PPM);

            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, visualMax);
            grad.addColorStop(0, 'rgba(56,120,230,0.55)');
            grad.addColorStop(0.5, 'rgba(56,120,230,0.2)');
            grad.addColorStop(1, 'rgba(56,120,230,0)');

            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.arc(cx, cy, dofMaxPx, startAngle, endAngle);
            ctx.closePath();
            ctx.fill();
        }

        ctx.strokeStyle = 'rgba(99,155,255,0.65)';
        ctx.lineWidth = 1.8 / scale;
        ctx.setLineDash([6 / scale, 5 / scale]);
        ctx.beginPath();
        ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(startAngle) * rDefault, cy + Math.sin(startAngle) * rDefault);
        ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(endAngle) * rDefault, cy + Math.sin(endAngle) * rDefault);
        ctx.stroke();
        ctx.setLineDash([]);
    }
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
    const tcx = table.x * PPM;
    const tcy = table.y * PPM;

    ctx.fillStyle = '#2D2D2F';
    ctx.strokeStyle = '#69696C';
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();

    if (tableShape === 'rectangular') {
        ctx.roundRect(tx, ty, tw, th, 10);
    } else if (tableShape === 'circular') {
        ctx.ellipse(tcx, tcy, tw/2, th/2, 0, 0, Math.PI * 2);
    } else if (tableShape === 'u-shape') {
        const thickness = Math.min(tw, th) * 0.3;
        const r = 8 / scale; 
        
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx, ty + th - r);
        ctx.arcTo(tx, ty + th, tx + r, ty + th, r);
        ctx.lineTo(tx + tw - r, ty + th);
        ctx.arcTo(tx + tw, ty + th, tx + tw, ty + th - r, r);
        ctx.lineTo(tx + tw, ty);
        
        ctx.lineTo(tx + tw - thickness, ty);
        ctx.lineTo(tx + tw - thickness, ty + th - thickness - r);
        ctx.arcTo(tx + tw - thickness, ty + th - thickness, tx + tw - thickness - r, ty + th - thickness, r);
        ctx.lineTo(tx + thickness + r, ty + th - thickness);
        ctx.arcTo(tx + thickness, ty + th - thickness, tx + thickness, ty + th - thickness - r, r);
        ctx.lineTo(tx + thickness, ty);
        ctx.closePath();
    }
    
    ctx.fill();
    ctx.stroke();

    if (selectedObject === 'table') {
        // Draw Drag Handles
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = 'rgba(139,92,246,1)';
        ctx.lineWidth = 1.5 / scale;
        const hR = 4 / scale;
        const corners = [
            {x: tx, y: ty}, {x: tx + tw, y: ty}, 
            {x: tx, y: ty + th}, {x: tx + tw, y: ty + th}
        ];
        corners.forEach(pt => {
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, hR, 0, Math.PI*2);
            ctx.fill();
            ctx.stroke();
        });
    }

    ctx.save();
    ctx.translate(tcx, tcy);
    ctx.fillStyle = 'rgba(196,181,253,0.85)';
    ctx.scale(1/scale, 1/scale);
    ctx.font = 'bold 12px Heebo, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${table.w.toFixed(1)}m × ${table.h.toFixed(1)}m`, 0, 0);
    ctx.restore();
}

const deviceIcons = {
    camera: new Path2D("M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"),
    mic: new Path2D("M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v4 M8 23h8"),
    speaker: new Path2D("M11 5L6 9H2v6h4l5 4V5z M19.07 4.93a10 10 0 0 1 0 14.14 M15.54 8.46a5 5 0 0 1 0 7.07"),
    display: new Path2D("M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M8 21h8 M12 17v4")
};

function drawDeviceBubble(cx, cy, rot, type, tagText) {
    const nodeRadius = 20 / scale; 
    const colors = { camera: '#0ea5e9', mic: '#f59e0b', speaker: '#10b981', display: '#8b5cf6' };
    const color = colors[type] || '#64748b';

    ctx.save();
    ctx.translate(cx, cy);
    
    // Determine rotation: for cameras, rotate relative to 90 degrees. Other devices stay upright (0).
    if (type === 'camera') {
        ctx.rotate((rot - 90) * Math.PI / 180);
    }
    
    // Bubble shadow and white circle
    ctx.beginPath();
    ctx.arc(0, 0, nodeRadius, 0, 2 * Math.PI);
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 8 / scale;
    ctx.shadowOffsetY = 2 / scale;
    ctx.fill();
    
    // Reset shadow
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    
    // Border
    ctx.lineWidth = 1.5 / scale;
    ctx.strokeStyle = '#e2e8f0';
    ctx.stroke();

    // Draw Icon 
    ctx.save();
    const iconScale = (22 / scale) / 24; 
    ctx.scale(iconScale, iconScale);
    ctx.translate(-12, -12);
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (deviceIcons[type]) ctx.stroke(deviceIcons[type]);
    ctx.restore();

    // Draw tag pill
    if (tagText) {
        ctx.font = `bold ${10 / scale}px Heebo, sans-serif`;
        const textW = ctx.measureText(tagText).width;
        const pillW = Math.max(24 / scale, textW + 8 / scale);
        const pillH = 14 / scale;
        const pillY = nodeRadius - (8 / scale); 
        
        ctx.beginPath();
        if (ctx.roundRect) {
            ctx.roundRect(-pillW/2, pillY, pillW, pillH, pillH/2);
        } else {
            ctx.rect(-pillW/2, pillY, pillW, pillH); // fallback
        }
        ctx.fillStyle = color;
        ctx.fill();
        
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(tagText, 0, pillY + pillH/2 + 0.5/scale);
    }
    ctx.restore();
}


function drawDisplays() {
    extraDisplays.forEach((d, idx) => {
        const cx = d.x * PPM;
        const cy = d.y * PPM;
        
        drawDeviceBubble(cx, cy, d.rot || 90, 'display', `#${idx+1}`);

        if (selectedObject && selectedObject.type === 'extraDisplay' && selectedObject.id === d.id) {
            drawSelectionHighlight(d);
        }
    });
}

function drawMics() {
    extraMics.forEach((m, idx) => {
        const cx = m.x * PPM;
        const cy = m.y * PPM;
        const r = m.radius * PPM;
        
        if (r > 0 && micDisplayMode !== 'hidden') {
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);

            if (micDisplayMode === 'fill') {
                const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
                grad.addColorStop(0, 'rgba(217, 119, 6, 0.1)');
                grad.addColorStop(1, 'rgba(217, 119, 6, 0)');
                ctx.fillStyle = grad;
                ctx.fill();
            }

            ctx.strokeStyle = 'rgba(217, 119, 6, 0.25)';
            ctx.lineWidth = 1.5 / scale;
            ctx.setLineDash([8 / scale, 6 / scale]);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        drawDeviceBubble(cx, cy, m.rot || 90, 'mic', `#${idx+1}`);

        if (selectedObject && selectedObject.type === 'extraMic' && selectedObject.id === m.id) {
            drawSelectionHighlight(m);
        }
    });
}

function drawSpeakers() {
    extraSpeakers.forEach((s, idx) => {
        const cx = s.x * PPM;
        const cy = s.y * PPM;
        
        drawDeviceBubble(cx, cy, s.rot || 90, 'speaker', `#${idx+1}`);

        if (selectedObject && selectedObject.type === 'extraSpeaker' && selectedObject.id === s.id) {
            drawSelectionHighlight(s);
        }
    });
}

function drawSingleCamera(c, label) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;
    
    // For single camera, the rot is already correctly managed, but maybe we want a slightly larger bubble?
    // We can just use drawDeviceBubble
    // The "multiCamEnabled" condition is nice for tags. We can pass label directly.
    drawDeviceBubble(cx, cy, c.rot, 'camera', multiCamEnabled ? label : null);
}

function drawCamera() {
    drawSingleCamera(cam, "1");
    if (selectedObject === 'cam') {
        drawCamHandle(cam);
    }
    if (multiCamEnabled) {
        extraCams.forEach((ec, idx) => {
            drawSingleCamera(ec, (idx + 2).toString());
            if (selectedObject && selectedObject.type === 'extraCam' && selectedObject.id === ec.id) {
                drawCamHandle(ec);
            }
        });
    }
}

function drawCamHandle(c) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;
    const r = 24 / scale; // Bounding box half size

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(c.rot * Math.PI / 180);

    // Bounding box
    ctx.strokeStyle = 'rgba(59,130,246,0.6)';
    ctx.lineWidth = 1.5 / scale;
    ctx.beginPath();
    ctx.rect(-r, -r, r*2, r*2);
    ctx.stroke();
    
    // Corner sizing squares (classic look)
    const cornerR = 2.5 / scale;
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 1.5 / scale;
    const corners = [
        [-r, -r], [r, -r], [-r, r], [r, r]
    ];
    corners.forEach(([px, py]) => {
        ctx.beginPath();
        ctx.rect(px - cornerR, py - cornerR, cornerR*2, cornerR*2);
        ctx.fill();
        ctx.stroke();
    });

    ctx.restore();

    // Hovering rotate handle at top-right
    const handleAngle = (c.rot - 45) * Math.PI / 180;
    const dist = 48 / scale; 
    const hx = cx + Math.cos(handleAngle) * dist;
    const hy = cy + Math.sin(handleAngle) * dist;

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.arc(hx, hy, 5.5 / scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    // Tiny dot in the middle of the rotate handle
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(hx, hy, 2 / scale, 0, Math.PI * 2);
    ctx.fill();
}

function drawRotKnob(c) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;
    const handleAngle = ((c.rot || 0) - 45) * Math.PI / 180;
    const dist = 48 / scale; 
    const hx = cx + Math.cos(handleAngle) * dist;
    const hy = cy + Math.sin(handleAngle) * dist;

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 2 / scale;
    ctx.beginPath();
    ctx.arc(hx, hy, 5.5 / scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(hx, hy, 2 / scale, 0, Math.PI * 2);
    ctx.fill();
}

function drawSelectionHighlight(c) {
    const cx = c.x * PPM;
    const cy = c.y * PPM;
    const r = 28 / scale; 

    ctx.save();
    ctx.translate(cx, cy);
    
    ctx.strokeStyle = '#00C09A';
    ctx.setLineDash([5 / scale, 5 / scale]);
    ctx.lineWidth = 1.5 / scale;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    
    ctx.restore();
}

// Load devices and initialize
loadDevices();
