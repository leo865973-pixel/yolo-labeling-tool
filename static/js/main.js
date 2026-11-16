/**
 * AI 影像標記工具 - 前端核心互動與狀態管理
 * 設計重點：
 * 1. 雙面向狀態分離：面向 A (檔案與格式檢查 format_status) vs 面向 B (人工作業進度 review_status)
 * 2. 三步驟清晰動線：1. 載入資料 -> 2. 批次套用 -> 3. 檢查與微調
 * 3. 真實儲存狀態回饋、防長按誤觸 (e.repeat)、佇列導向審核
 */

let scanData = null;

function workspaceFetch(url, options = {}, workspace = scanData?.workspace_id) {
    return fetch(url, { ...options, headers: {
        ...options.headers, 'X-YOLO-Workspace': workspace || ''
    }}).then(response => {
        const readJson = response.json.bind(response);
        response.json = async () => {
            const data = await readJson();
            return workspace === scanData?.workspace_id ? data : { ok: false, error: '已切換專案，忽略舊專案回應。' };
        };
        return response;
    });
}

function workspaceImage(stem, cacheBust = false) {
    if (window.YoloWebEngine && typeof window.YoloWebEngine.isActive === 'function' && window.YoloWebEngine.isActive()) {
        return window.YoloWebEngine.getImageUrl(stem);
    }
    const base = `/api/image/${encodeURIComponent(stem)}?workspace=${encodeURIComponent(scanData?.workspace_id || '')}`;
    return cacheBust ? `${base}&t=${Date.now()}` : base;
}

let currentStep = 'load'; // 'load' | 'apply' | 'review'

// 步驟 2 (批次套用) 狀態
let masterStem = null;
let copySelectedStems = new Set();
let similarityMap = {}; // stem -> { similarity, reason }
let recommendedGroups = [];

// 步驟 3 (檢查與微調) 狀態
let reviewQueue = []; // 本次待檢查佇列 (stems)
let reviewScope = 'queue'; // 'queue' | 'all'
let currentFilter = 'all';
let activeStem = null;
let previewMode = 'single'; // 'single' | 'side_by_side' | 'overlay'
let overlayAlpha = 0.45;
let zoomMultiplier = 1.0;

// 畫布互動與儲存狀態
let targetImgObj = null;
let masterImgObj = null;
let canvasRenderState = null;
let selectedBoxIndex = -1;
let dragAction = null;
let isDrawBoxMode = false;
let isMagnifierLoupeEnabled = true;
let defaultDrawClassId = 0;
let canvasHoverPos = null;
let pendingNewBox = null;
let pendingClassEditBoxIdx = -1;
let isSavingCanvas = false;
let activeSavePromise = null;
let reviewUpdatePending = false;
let lastSaveFailed = false;
let pendingSavePayload = null;
let dirtyCanvasStem = null;
let dirtyCanvasOrigState = null;
let localCanvasUndoStack = [];

const CLASS_COLORS = [
    '#2874A6', '#1E8449', '#D35400', '#8E44AD',
    '#C0392B', '#117864', '#B9770E', '#2E4053'
];

// ============================================================================
// 初始化與啟動檢查
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {

    initCanvasInteraction();
    initPhotoListWidth();
    document.documentElement.dataset.textSize = 'standard';
    if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(() => {
            if (currentStep === 'review') redrawCanvases();
        });
        observer.observe(document.getElementById('mainCanvasWrapper'));
        observer.observe(document.getElementById('masterCanvasWrapper'));
    }
    initKeyboardShortcuts();

    window.addEventListener('resize', () => {
        if (currentStep === 'review') updateReviewLayout();
    });
});





// ============================================================================
// 導覽切換與狀態保存
// ============================================================================
async function switchStep(stepName) {
    if (stepName === 'load' && scanData?.ok) {
        if (dirtyCanvasStem) {
            const flushed = await flushUnsavedCanvasDraftIfNeeded();
            if (!flushed) return;
        }
        openModal('pathSettingsModal');
        return;
    }
    if (stepName !== 'load' && (!scanData || !scanData.ok)) {
        showToast('請先載入照片資料夾', 'warn');
        return;
    }
    if (stepName !== currentStep && dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    currentStep = stepName;

    document.querySelectorAll('.workspace-nav-btn').forEach(btn => {
        const active = btn.dataset.step === stepName;
        btn.classList.toggle('active', active);
        if (active) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
    });
    document.querySelectorAll('.step-view').forEach(sec => {
        sec.classList.toggle('active', sec.id === `step-${stepName}`);
    });

    if (stepName === 'apply') {
        renderBatchApplyStep();
    } else if (stepName === 'review') {
        setReviewScope(reviewScope);
        setTimeout(updateReviewLayout, 30);
    }
}

async function saveSessionProgress() {
    if (!scanData || !scanData.ok) return;
    try {
        await workspaceFetch('/api/save_session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                active_stem: activeStem || '',
                master_stem: masterStem || '',
                current_filter: currentFilter,
                review_queue: reviewQueue
            })
        });
    } catch (_) {}
}

// ============================================================================
// 步驟 1：載入資料與掃描
// ============================================================================
let isPickingPath = false;

async function pickAndLoadFolder() {
    if (isPickingPath) {
        showToast('資料夾選擇視窗已經開啟，請查看桌面或工作列彈出視窗。', 'info');
        return;
    }
    isPickingPath = true;
    const welcomeBtn = document.getElementById('btnWelcomePickFolder');
    const origText = welcomeBtn ? welcomeBtn.textContent : '選擇照片資料夾';
    if (welcomeBtn) {
        welcomeBtn.disabled = true;
        welcomeBtn.textContent = '正在開啟資料夾選擇視窗...';
    }
    showToast(window.YOLO_WEB_MODE ? '請在彈出的視窗選擇照片資料夾並點選「允許」...' : '正在開啟 Windows 資料夾選擇視窗...', 'info');

    try {
        const res = await fetch('/api/pick_path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'folder', title: '選擇照片與標記檔所在的資料夾' })
        });
        const data = await res.json();
        if (data.ok && data.path) {
            if (dirtyCanvasStem) {
                await flushUnsavedCanvasDraftIfNeeded();
            }
            // 重設前次範例或前次專案的殘留選擇狀態
            dirtyCanvasStem = null;
            dirtyCanvasOrigState = null;
            localCanvasUndoStack = [];
            masterStem = null;
            copySelectedStems.clear();
            reviewQueue = [];
            activeStem = null;
            similarityMap = {};
            simBannerState = { active: false, warnings: [] };

            document.getElementById('inputImageDir').value = data.path;
            document.getElementById('inputImageDirLoaded').value = data.path;
            document.getElementById('inputClassesPath').value = '';
            await scanCurrentWorkspace({ restoreSession: true });
            showToast(`已成功載入資料夾：${scanData?.folder_name || data.path}`, 'success');
        } else if (data.ok && data.cancelled) {
            showToast('已取消選擇資料夾', 'info');
        } else {
            showToast(data.error || '無法開啟系統資料夾選擇器，已為您展開手動路徑輸入框。', 'warn');
            const detailsEl = document.querySelector('.manual-path-details');
            if (detailsEl) detailsEl.open = true;
            toggleLoadSettingsPanel(true);
        }
    } catch (e) {
        showToast('無法開啟系統資料夾選擇器，請於下方手動貼上資料夾路徑。', 'error');
        const detailsEl = document.querySelector('.manual-path-details');
        if (detailsEl) detailsEl.open = true;
        toggleLoadSettingsPanel(true);
    } finally {
        isPickingPath = false;
        if (welcomeBtn) {
            welcomeBtn.disabled = false;
            welcomeBtn.textContent = origText;
        }
    }
}

async function pickPath(inputId, mode) {
    if (isPickingPath) {
        showToast('選擇視窗已經開啟，請查看桌面或工作列彈出視窗。', 'info');
        return;
    }
    isPickingPath = true;
    showToast('正在開啟系統選擇視窗...', 'info');
    try {
        const res = await fetch('/api/pick_path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const data = await res.json();
        if (data.ok && data.path) {
            document.getElementById(inputId).value = data.path;
            if (inputId === 'inputCopyOutputDir') {
                runMasterCopyPreview();
            } else if (inputId === 'inputImageDirLoaded') {
                masterStem = null;
                copySelectedStems.clear();
                reviewQueue = [];
                activeStem = null;
                similarityMap = {};
                await rescanFromLoadedSettings();
            }
        } else if (!data.ok) {
            showToast(data.error || '無法開啟選擇視窗，請直接貼上路徑', 'warn');
        }
    } catch (e) {
        showToast('無法開啟檔案選擇視窗', 'error');
    } finally {
        isPickingPath = false;
    }
}

async function openInExplorer(inputOrElemId) {
    const el = document.getElementById(inputOrElemId);
    const pathVal = el ? (el.value || el.textContent) : '';
    if (!pathVal) return;
    await openFolderPath(pathVal.trim());
}

async function openFolderPath(path) {
    try {
        const response = await fetch('/api/open_folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path })
        });
        const data = await response.json();
        if (!data.ok) showToast(data.error || '無法開啟資料夾', 'error');
    } catch {
        showToast('無法連線開啟資料夾', 'error');
    }
}

function toggleLoadSettingsPanel() { openModal('pathSettingsModal'); }



const SHARED_CLASSES_LS_KEY = 'yolo_shared_classes_cfg_v1';
const LAST_FOLDER_CLASSES_HINT_LS_KEY = 'yolo_last_folder_classes_hint_v1';
const sharedClassesGuideDismissedWs = new Set();

function canonSharedPath(p) {
    return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function loadLocalSharedClassesCfg() {
    try {
        const raw = localStorage.getItem(SHARED_CLASSES_LS_KEY);
        if (!raw) return { path: '', fileName: '', lockOverride: false, boundWorkspaces: [] };
        const parsed = JSON.parse(raw);
        return {
            path: typeof parsed.path === 'string' ? parsed.path : '',
            fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
            lockOverride: Boolean(parsed.lockOverride),
            boundWorkspaces: Array.isArray(parsed.boundWorkspaces) ? parsed.boundWorkspaces.filter(Boolean) : []
        };
    } catch (_) {
        return { path: '', fileName: '', lockOverride: false, boundWorkspaces: [] };
    }
}

function saveLocalSharedClassesCfg(cfg) {
    try {
        localStorage.setItem(SHARED_CLASSES_LS_KEY, JSON.stringify({
            path: cfg.path || '',
            fileName: cfg.fileName || '',
            lockOverride: Boolean(cfg.lockOverride),
            boundWorkspaces: Array.isArray(cfg.boundWorkspaces) ? cfg.boundWorkspaces : []
        }));
    } catch (_) {}
}

function loadLastFolderClassesHint() {
    try {
        const raw = localStorage.getItem(LAST_FOLDER_CLASSES_HINT_LS_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.folderPath && Array.isArray(parsed.classes) && parsed.classes.length > 0) {
            return parsed;
        }
    } catch (_) {}
    return null;
}

function isMemoryOrSampleScan(scan) {
    if (!scan || !scan.workspace_id) return true;
    const imgDir = String(scan.image_dir || '');
    return imgDir.startsWith('[記憶體範例]');
}

function recordPrevFolderClassesHint(scan) {
    if (isMemoryOrSampleScan(scan)) return;
    if (scan.shared_classes_info && scan.shared_classes_info.has_binding) return;
    if (Array.isArray(scan.classes) && scan.classes.length > 0) {
        try {
            localStorage.setItem(LAST_FOLDER_CLASSES_HINT_LS_KEY, JSON.stringify({
                folderPath: scan.image_dir || '',
                folderName: scan.folder_name || scan.image_dir || '',
                classes: scan.classes.map(c => String(c || '').trim()).filter(Boolean)
            }));
        } catch (_) {}
    }
}

function isPathUnderSharedDir(folderPath, sharedFilePath) {
    const f = String(folderPath || '').trim();
    const s = String(sharedFilePath || '').trim();
    if (!f || !s || f.startsWith('[') || s.startsWith('[')) return false;
    const fNorm = f.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const sParts = s.replace(/\//g, '\\').split('\\');
    sParts.pop();
    const sDir = sParts.join('\\').replace(/\\+$/, '').toLowerCase();
    if (!sDir) return false;
    return fNorm === sDir || fNorm.startsWith(sDir + '\\');
}

function areSiblingOrSameTreePaths(pathA, pathB) {
    const a = String(pathA || '').trim();
    const b = String(pathB || '').trim();
    if (!a || !b) return false;
    if (canonSharedPath(a) === canonSharedPath(b)) return false;
    if (a.startsWith('[') || b.startsWith('[')) return true;
    const normA = a.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const normB = b.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const parentA = normA.includes('\\') ? normA.slice(0, normA.lastIndexOf('\\')) : '';
    const parentB = normB.includes('\\') ? normB.slice(0, normB.lastIndexOf('\\')) : '';
    if (!parentA || !parentB) return false;
    return parentA === parentB || normA.startsWith(parentB + '\\') || normB.startsWith(parentA + '\\');
}

function computePythonSharedClassesInfo(scan, prevSharedInfo = null) {
    if (!scan || isMemoryOrSampleScan(scan)) return null;
    if (window.YoloWebEngine?.isActive()) return scan.shared_classes_info || prevSharedInfo || null;
    const cfg = loadLocalSharedClassesCfg();
    const effectivePath = cfg.path || prevSharedInfo?.virtual_path || '';
    if (!effectivePath) {
        return {
            has_binding: false,
            active: false,
            file_name: '',
            virtual_path: '',
            lock_override: false,
            needs_permission: false,
            missing_file: false,
            has_local_classes_file: Boolean(scan.classes_file_exists),
            bound_workspaces: [],
            last_shared_available: false,
            last_shared_name: ''
        };
    }
    const active = Boolean(scan.classes_path && canonSharedPath(scan.classes_path) === canonSharedPath(effectivePath));
    const isBound = Array.isArray(cfg.boundWorkspaces) && cfg.boundWorkspaces.some(w => canonSharedPath(w) === canonSharedPath(scan.image_dir));
    const underRoot = isPathUnderSharedDir(scan.image_dir, effectivePath);
    const hasBinding = Boolean(active || cfg.lockOverride || isBound || (underRoot && !scan.classes_file_exists));
    return {
        has_binding: hasBinding,
        active,
        file_name: hasBinding ? (cfg.fileName || prevSharedInfo?.file_name || 'classes.txt') : '',
        virtual_path: hasBinding ? effectivePath : '',
        lock_override: Boolean(cfg.lockOverride),
        needs_permission: false,
        missing_file: Boolean(prevSharedInfo?.missing_file),
        has_local_classes_file: Boolean(prevSharedInfo?.has_local_classes_file ?? scan.classes_file_exists),
        bound_workspaces: cfg.boundWorkspaces || [],
        last_shared_available: Boolean(!active && !hasBinding && (prevSharedInfo?.last_shared_available ?? Boolean(cfg.path))),
        last_shared_name: prevSharedInfo?.last_shared_name || cfg.fileName || 'classes.txt'
    };
}

function buildSharedGuideBannerHtml(opts) {
    const actionsHtml = (opts.actions || []).map(act =>
        `<button type="button" class="${act.cls || 'btn btn-secondary btn-sm'}" onclick="${act.onclick}">${act.label}</button>`
    ).join('');
    return `
        <div class="shared-classes-guide-body">
            <div class="shared-classes-guide-title">${opts.title}</div>
            <div class="shared-classes-guide-desc">${opts.desc}</div>
        </div>
        <div class="shared-classes-guide-actions">${actionsHtml}</div>
    `;
}

function renderSharedClassesGuidance() {
    const pillBtn = document.getElementById('sharedClassesStatusPill');
    const pillText = document.getElementById('sharedClassesPillText');
    const optRow = document.getElementById('sharedClassesOptionsRow');
    const optBadge = document.getElementById('sharedClassesBindingBadge');
    const optPath = document.getElementById('sharedClassesBindingPath');
    const chkLock = document.getElementById('chkLockSharedClasses');
    const loadBanner = document.getElementById('sharedClassesLoadGuide');
    const reviewBanner = document.getElementById('sharedClassesGuideBanner');

    const applyBannerState = (el, show, themeClass, html) => {
        if (!el) return;
        el.classList.remove('guide-warn', 'guide-nextstep');
        if (!show) {
            el.style.display = 'none';
            el.innerHTML = '';
            return;
        }
        if (themeClass) el.classList.add(themeClass);
        el.innerHTML = html;
        el.style.display = 'flex';
    };

    if (!scanData || !scanData.ok || isMemoryOrSampleScan(scanData)) {
        if (pillBtn) pillBtn.style.display = 'none';
        if (optRow) optRow.style.display = 'none';
        applyBannerState(loadBanner, false);
        applyBannerState(reviewBanner, false);
        return;
    }

    const sInfo = scanData.shared_classes_info || null;
    const classesList = Array.isArray(scanData.classes) ? scanData.classes : [];
    const curWsId = scanData.workspace_id || '';
    const isDismissed = sharedClassesGuideDismissedWs.has(curWsId);

    // 1. 頂部狀態膠囊 & 路徑設定彈窗內的共用管理列
    if (pillBtn && pillText) {
        if (sInfo && sInfo.needs_permission && !sInfo.active) {
            pillBtn.classList.add('is-pending-auth');
            pillBtn.onclick = () => authorizeAndApplySharedClasses();
            pillText.textContent = `⚠ 點此授權共用類別：${sInfo.file_name || 'classes.txt'}`;
            pillBtn.style.display = 'inline-flex';
        } else if (sInfo && sInfo.active) {
            pillBtn.classList.remove('is-pending-auth');
            pillBtn.onclick = () => openModal('pathSettingsModal');
            pillText.textContent = `📌 共用類別：${sInfo.file_name || 'classes.txt'} (${classesList.length}類)`;
            pillBtn.style.display = 'inline-flex';
        } else if (sInfo && sInfo.has_binding) {
            pillBtn.classList.remove('is-pending-auth');
            pillBtn.onclick = () => openModal('pathSettingsModal');
            pillText.textContent = `📌 已綁共用檔（目前用本機類別檔）`;
            pillBtn.style.display = 'inline-flex';
        } else {
            pillBtn.style.display = 'none';
        }
    }

    if (optRow) {
        if (sInfo && sInfo.has_binding) {
            optRow.style.display = 'flex';
            if (optBadge) {
                optBadge.textContent = sInfo.active ? '✅ 目前資料夾使用中共用檔' : (sInfo.needs_permission ? '⚠️ 待授權共用檔' : '⏸️ 已綁定但未覆蓋本機檔');
            }
            if (optPath) {
                optPath.textContent = sInfo.virtual_path || sInfo.file_name || '';
            }
            if (chkLock) {
                chkLock.checked = Boolean(sInfo.lock_override);
            }
        } else {
            optRow.style.display = 'none';
        }
    }

    // 2. 分級情境引導（A/B/D 提升為寬敞置中決策彈窗；C 顯示精簡下一步橫幅；未決策前載入頁亦保留入口）
    const hasPhotos = Boolean(scanData.summary && scanData.summary.photo_count > 0);
    let modalConfig = null;
    let loadCardHtml = '';
    let loadCardTheme = '';
    let reviewStripHtml = '';
    let reviewStripTheme = '';

    if (sInfo && sInfo.needs_permission && !sInfo.active) {
        // 情境 D：瀏覽器重開後需要一鍵重新授權讀取共用的 classes.txt
        modalConfig = {
            isWarn: true,
            title: `偵測到上次共用的類別檔「${escapeHtml(sInfo.file_name || 'classes.txt')}」`,
            subtitle: '',
            bodyHtml: `
                <div class="setup-auth-card">
                    <p>點擊下方「<strong>一鍵授權並繼續共用</strong>」，並允許瀏覽器讀寫該檔案，即可讓此資料夾沿用原本共用的類別定義。</p>
                    <div class="setup-auth-actions">
                        <button type="button" class="btn btn-primary btn-lg" onclick="authorizeAndApplySharedClasses()">✓ 一鍵授權並繼續共用</button>
                        <button type="button" class="btn btn-secondary" onclick="clearSharedClassesBinding()">改用本機檔</button>
                    </div>
                </div>
            `
        };
        loadCardTheme = 'guide-warn';
        loadCardHtml = buildSharedGuideBannerHtml({
            title: modalConfig.title,
            desc: '',
            actions: [
                { label: '✓ 一鍵授權並繼續共用', cls: 'btn btn-primary btn-sm', onclick: 'authorizeAndApplySharedClasses()' },
                { label: '改用本機檔', cls: 'btn btn-secondary btn-sm', onclick: 'clearSharedClassesBinding()' }
            ]
        });
    } else if (sInfo && sInfo.active && classesList.length === 0) {
        // 已選擇／建立空白共用檔：關閉設定彈窗，不重複在畫布上方顯示就緒橫幅
        if (activeModal && activeModal.id === 'sharedClassesSetupModal') {
            closeModal('sharedClassesSetupModal');
        }
    } else if ((!sInfo || !sInfo.has_binding) && !scanData.classes_file_exists && classesList.length === 0) {
        const prevHint = loadLastFolderClassesHint();
        const isRelatedPrev = Boolean(prevHint && areSiblingOrSameTreePaths(prevHint.folderPath, scanData.image_dir));
        const reuseLastSharedBtnHtml = (sInfo && sInfo.last_shared_available && sInfo.last_shared_name)
            ? `<button type="button" class="btn btn-primary" onclick="useLastSharedClassesForCurrentFolder()">🔗 沿用上次共用檔（${escapeHtml(sInfo.last_shared_name)}）</button>`
            : '';
        if (isRelatedPrev) {
            // 情境 B：同專案上層下剛標完 ok/，切進空白 ng/ 時優先跳大彈窗防止編號撞名
            const prevNames = prevHint.classes.slice(0, 3).map((c, idx) => `${idx}: ${escapeHtml(c)}`).join('、');
            const moreText = prevHint.classes.length > 3 ? ` 等 ${prevHint.classes.length} 類` : '';
            const bringPreview = prevHint.classes.slice(0, 2).map(escapeHtml).join('、') + (prevHint.classes.length > 2 ? '…' : '');
            modalConfig = {
                isWarn: true,
                title: `「${escapeHtml(scanData.folder_name || '目前資料夾')}」尚未建立 classes.txt`,
                subtitle: `上個資料夾「${escapeHtml(prevHint.folderName)}」已建有 [${prevNames}${moreText}]，建議共用以免編號撞名。`,
                bodyHtml: `
                    <div class="setup-cards-grid">
                        <div class="setup-option-card is-recommended">
                            <div class="setup-option-head">
                                <h4>📂 共用同一份清單</h4>
                                <span class="setup-rec-tag">推薦</span>
                            </div>
                            <p class="setup-option-desc">帶入「${escapeHtml(prevHint.folderName)}」類別，新增時自動接續編號。</p>
                            <pre class="setup-folder-tree">📂 上層共用資料夾/
  ├── 🏷️ classes.txt  (含 ${bringPreview} + 新類別)
  ├── 📁 ${escapeHtml(prevHint.folderName)}/
  └── 📁 ${escapeHtml(scanData.folder_name || '目前資料夾')}/</pre>
                            <div class="setup-card-actions">
                                <button type="button" class="btn btn-primary btn-lg" onclick="createSharedClassesFromPrevHint()">✨ 新建共用檔（帶入：${bringPreview}）</button>
                                <button type="button" class="btn btn-secondary" onclick="pickSharedClassesFile()">📄 挑選現有檔案</button>
                            </div>
                        </div>
                        <div class="setup-option-card">
                            <div class="setup-option-head">
                                <h4>📁 此資料夾各自獨立使用</h4>
                            </div>
                            <p class="setup-option-desc">從編號 0 建立自己的類別檔。</p>
                            <pre class="setup-folder-tree">📂 ${escapeHtml(scanData.folder_name || '目前資料夾')}/
  ├── 🖼️ 照片與 📄 標記檔
  └── 🏷️ classes.txt  (獨立編號 0)</pre>
                            <div class="setup-card-actions">
                                <button type="button" class="btn btn-secondary btn-lg" onclick="startSingleFolderDirect()">＋ 獨立畫框 (W)</button>
                            </div>
                        </div>
                    </div>
                `
            };
            loadCardTheme = 'guide-warn';
            loadCardHtml = buildSharedGuideBannerHtml({
                title: `⚠️ 尚未建立 classes.txt（前資料夾已有 ${prevNames}${moreText}）`,
                desc: '',
                actions: [
                    { label: '設定類別檔', cls: 'btn btn-primary btn-sm', onclick: 'openSharedClassesSetupModalManually()' }
                ]
            });
        } else {
            // 情境 A：全新無 classes.txt 的資料夾 — 寬敞雙欄圖示決策彈窗
            modalConfig = {
                isWarn: false,
                title: '尚未建立類別檔 (classes.txt)',
                subtitle: '',
                bodyHtml: `
                    <div class="setup-cards-grid">
                        <div class="setup-option-card">
                            <div class="setup-option-head">
                                <h4>📁 只有這一個資料夾</h4>
                            </div>
                            <p class="setup-option-desc">畫框後自動於此資料夾建立 <code>classes.txt</code>。</p>
                            <pre class="setup-folder-tree">📂 ${escapeHtml(scanData.folder_name || '專案資料夾')}/
  ├── 🖼️ 照片_01.jpg
  ├── 📄 照片_01.txt
  └── 🏷️ classes.txt  ← 自動建在這</pre>
                            <div class="setup-card-actions">
                                <button type="button" class="btn btn-primary btn-lg" onclick="startSingleFolderDirect()">＋ 直接畫框 (W)</button>
                            </div>
                        </div>
                        <div class="setup-option-card">
                            <div class="setup-option-head">
                                <h4>📂 分成多個資料夾（如 ok/、ng/）</h4>
                            </div>
                            <p class="setup-option-desc">把類別檔放上一層共用，切換資料夾自動同步。</p>
                            <pre class="setup-folder-tree">📂 上層資料夾/
  ├── 🏷️ classes.txt  ← 共用這份
  ├── 📁 ok/  (照片與標記)
  └── 📁 ng/  (照片與標記)</pre>
                            <div class="setup-card-actions">
                                ${reuseLastSharedBtnHtml}
                                <button type="button" class="btn btn-secondary btn-lg" onclick="createSharedClassesFile()">✨ 新建共用檔</button>
                                <button type="button" class="btn btn-ghost" onclick="pickSharedClassesFile()">📄 挑選現有檔案</button>
                            </div>
                        </div>
                    </div>
                `
            };
            loadCardHtml = buildSharedGuideBannerHtml({
                title: '💡 尚未建立類別檔 (classes.txt)',
                desc: '',
                actions: [
                    { label: '設定類別檔', cls: 'btn btn-primary btn-sm', onclick: 'openSharedClassesSetupModalManually()' }
                ]
            });
        }
    }

    if (loadCardHtml) {
        applyBannerState(loadBanner, true, loadCardTheme, loadCardHtml);
    } else {
        applyBannerState(loadBanner, false);
    }

    if (reviewStripHtml) {
        applyBannerState(reviewBanner, true, reviewStripTheme, reviewStripHtml);
    } else {
        applyBannerState(reviewBanner, false);
    }

    if (modalConfig && hasPhotos && !isDismissed && !isGuidedTourActive() && (!activeModal || activeModal.id === 'sharedClassesSetupModal')) {
        populateSharedSetupModal(modalConfig);
        if (!activeModal || activeModal.id !== 'sharedClassesSetupModal') {
            openModal('sharedClassesSetupModal');
        }
    } else if (!modalConfig && activeModal && activeModal.id === 'sharedClassesSetupModal') {
        closeModal('sharedClassesSetupModal');
    }
}

function populateSharedSetupModal(cfg) {
    const hdr = document.getElementById('sharedSetupHeader');
    const title = document.getElementById('sharedSetupModalTitle');
    const sub = document.getElementById('sharedSetupSubtitle');
    const body = document.getElementById('sharedSetupBody');
    if (!hdr || !title || !body) return;
    hdr.classList.toggle('is-warn', Boolean(cfg.isWarn));
    title.innerHTML = cfg.title || '';
    if (sub) {
        sub.innerHTML = cfg.subtitle || '';
        sub.style.display = cfg.subtitle ? '' : 'none';
    }
    body.innerHTML = cfg.bodyHtml || '';
}

function openSharedClassesSetupModalManually() {
    if (scanData?.workspace_id) {
        sharedClassesGuideDismissedWs.delete(scanData.workspace_id);
    }
    renderSharedClassesGuidance();
}

function dismissSharedClassesGuide() {
    if (scanData?.workspace_id) {
        sharedClassesGuideDismissedWs.add(scanData.workspace_id);
    }
    if (activeModal && activeModal.id === 'sharedClassesSetupModal') {
        closeModal('sharedClassesSetupModal');
    }
    renderSharedClassesGuidance();
}

function startSingleFolderDirect() {
    if (scanData?.workspace_id) {
        sharedClassesGuideDismissedWs.add(scanData.workspace_id);
    }
    if (activeModal && activeModal.id === 'sharedClassesSetupModal') {
        closeModal('sharedClassesSetupModal');
    }
    renderSharedClassesGuidance();
    triggerDrawBoxFromSharedGuide();
}

function triggerDrawBoxFromSharedGuide() {
    if (currentStep !== 'review') {
        switchStep('review');
    }
    if (!activeStem && Array.isArray(scanData?.items)) {
        const firstPhoto = scanData.items.find(i => i.has_image);
        if (firstPhoto) activeStem = firstPhoto.stem;
    }
    toggleDrawBoxMode(true);
}

async function applyPickedSharedClassesResult(data, extraBoundPaths = []) {
    if (!data || !data.ok || !data.path || data.cancelled) return false;
    if (dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return false;
    }
    document.getElementById('inputClassesPath').value = data.path;
    if (!window.YoloWebEngine?.isActive()) {
        const prevCfg = loadLocalSharedClassesCfg();
        const boundSet = new Set(prevCfg.boundWorkspaces || []);
        if (scanData?.image_dir) boundSet.add(scanData.image_dir);
        extraBoundPaths.forEach(p => { if (p) boundSet.add(p); });
        saveLocalSharedClassesCfg({
            path: data.path,
            fileName: data.file_name || 'classes.txt',
            lockOverride: prevCfg.lockOverride,
            boundWorkspaces: Array.from(boundSet)
        });
    }
    if (scanData?.workspace_id) {
        sharedClassesGuideDismissedWs.delete(scanData.workspace_id);
    }
    if (activeModal && (activeModal.id === 'sharedClassesSetupModal' || activeModal.id === 'pathSettingsModal')) {
        closeModal(activeModal.id);
    }
    await scanCurrentWorkspace({
        classesPathOverride: data.path,
        keepStep: currentStep !== 'load'
    });
    return true;
}

async function createSharedClassesFile(options = {}) {
    if (isPickingPath) {
        showToast('選擇視窗已經開啟，請完成或取消目前視窗。', 'info');
        return;
    }
    isPickingPath = true;
    try {
        const curClasses = Array.isArray(options.initialClasses)
            ? options.initialClasses
            : (Array.isArray(scanData?.classes) ? scanData.classes : []);
        const cleanedClasses = curClasses.map(c => String(c || '').trim()).filter(Boolean);
        const initialContent = cleanedClasses.length > 0 ? cleanedClasses.join('\n') + '\n' : '';
        const extraBoundPaths = Array.isArray(options.extraBoundPaths) ? options.extraBoundPaths : [];

        const res = await fetch('/api/pick_path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: 'save_file',
                suggested_name: 'classes.txt',
                title: '建議儲存在「上一層共用資料夾」並命名為 classes.txt',
                initial_dir: scanData?.image_dir || '',
                prefer_parent: true,
                write_initial: true,
                initial_content: initialContent,
                extra_bound_paths: extraBoundPaths
            })
        });
        const data = await res.json();
        if (data.ok && data.path) {
            const ok = await applyPickedSharedClassesResult(data, extraBoundPaths);
            if (ok) {
                const msgPrefix = cleanedClasses.length > 0
                    ? `已建立共用檔「${data.file_name || 'classes.txt'}」（已帶入 ${cleanedClasses.join('、')}）`
                    : `已建立共用檔「${data.file_name || 'classes.txt'}」`;
                showToast(msgPrefix, 'success');
            }
        } else if (!data.ok) {
            showToast(data.error || '無法開啟建立檔案視窗', 'warn');
        }
    } catch (e) {
        showToast('建立共用類別檔時發生錯誤', 'error');
    } finally {
        isPickingPath = false;
    }
}

async function createSharedClassesFromPrevHint() {
    const prevHint = loadLastFolderClassesHint();
    if (!prevHint || !Array.isArray(prevHint.classes) || prevHint.classes.length === 0) {
        return createSharedClassesFile();
    }
    return createSharedClassesFile({
        initialClasses: prevHint.classes,
        extraBoundPaths: prevHint.folderPath ? [prevHint.folderPath] : []
    });
}

async function pickSharedClassesFile() {
    if (isPickingPath) {
        showToast('選擇視窗已經開啟，請查看桌面或瀏覽器對話框。', 'info');
        return;
    }
    isPickingPath = true;
    try {
        const prevHint = loadLastFolderClassesHint();
        const extraBoundPaths = prevHint?.folderPath ? [prevHint.folderPath] : [];
        const res = await fetch('/api/pick_path', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mode: 'file',
                title: '選擇共用的 classes.txt 類別定義檔',
                initial_dir: scanData?.image_dir || '',
                prefer_parent: true,
                extra_bound_paths: extraBoundPaths
            })
        });
        const data = await res.json();
        if (data.ok && data.path) {
            const ok = await applyPickedSharedClassesResult(data, extraBoundPaths);
            if (ok) {
                showToast(`已連結共用類別檔：${data.file_name || data.path}`, 'success');
            }
        } else if (!data.ok) {
            showToast(data.error || '無法開啟檔案選擇視窗', 'warn');
        }
    } catch (e) {
        showToast('選擇共用類別檔時發生錯誤', 'error');
    } finally {
        isPickingPath = false;
    }
}

async function authorizeAndApplySharedClasses() {
    try {
        const localSharedCfg = loadLocalSharedClassesCfg();
        const res = await fetch('/api/shared_classes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'authorize',
                bind_current: true,
                shared_classes_path: localSharedCfg.path || scanData?.shared_classes_info?.virtual_path || ''
            })
        });
        const data = await res.json();
        if (!data.ok) {
            if (data.missing_file) {
                saveLocalSharedClassesCfg({ path: '', fileName: '', lockOverride: false, boundWorkspaces: [] });
                const clsInput = document.getElementById('inputClassesPath');
                if (clsInput) clsInput.value = '';
                if (activeModal && activeModal.id === 'sharedClassesSetupModal') {
                    closeModal('sharedClassesSetupModal');
                }
                showToast(data.error || '找不到原本的共用類別檔（可能已被刪除），已自動清除舊設定。', 'warn');
                if (scanData?.ok) {
                    await scanCurrentWorkspace({
                        classesPathOverride: '',
                        keepStep: currentStep !== 'load'
                    });
                }
                return;
            }
            showToast(data.error || '未取得檔案授權，請再點選允許', 'warn');
            return;
        }
        if (dirtyCanvasStem) {
            const flushed = await flushUnsavedCanvasDraftIfNeeded();
            if (!flushed) return;
        }
        document.getElementById('inputClassesPath').value = data.path || '';
        await scanCurrentWorkspace({
            classesPathOverride: data.path || '',
            keepStep: currentStep !== 'load'
        });
        showToast(`已重新授權共用類別檔：${data.file_name || 'classes.txt'}`, 'success');
    } catch (e) {
        showToast('授權共用類別檔失敗', 'error');
    }
}

async function useLastSharedClassesForCurrentFolder() {
    if (!scanData?.ok) return;
    if (window.YoloWebEngine?.isActive()) {
        await authorizeAndApplySharedClasses();
        return;
    }
    const cfg = loadLocalSharedClassesCfg();
    if (!cfg.path) {
        showToast('找不到先前的共用類別檔記錄，請改用「挑選現有檔案」。', 'warn');
        return;
    }
    const boundSet = new Set(cfg.boundWorkspaces || []);
    if (scanData.image_dir) boundSet.add(scanData.image_dir);
    saveLocalSharedClassesCfg({
        ...cfg,
        boundWorkspaces: Array.from(boundSet)
    });
    if (activeModal && activeModal.id === 'sharedClassesSetupModal') {
        closeModal('sharedClassesSetupModal');
    }
    await scanCurrentWorkspace({
        classesPathOverride: cfg.path,
        keepStep: currentStep !== 'load'
    });
    showToast(`已沿用共用類別檔：${cfg.fileName || 'classes.txt'}`, 'success');
}

async function toggleLockSharedClasses(checked) {
    const lockOverride = Boolean(checked);
    if (window.YoloWebEngine?.isActive()) {
        await fetch('/api/shared_classes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'set_lock', lock_override: lockOverride })
        });
    } else {
        const cfg = loadLocalSharedClassesCfg();
        cfg.lockOverride = lockOverride;
        saveLocalSharedClassesCfg(cfg);
    }
    if (scanData?.ok) {
        document.getElementById('inputClassesPath').value = '';
        await scanCurrentWorkspace({
            classesPathOverride: '',
            keepStep: currentStep !== 'load'
        });
    }
    showToast(lockOverride ? '已設定優先使用共用類別檔' : '已改回尊重資料夾既有類別檔', 'info');
}

async function clearSharedClassesBinding() {
    if (dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    if (window.YoloWebEngine?.isActive()) {
        await fetch('/api/shared_classes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear' })
        });
    } else {
        saveLocalSharedClassesCfg({ path: '', fileName: '', lockOverride: false, boundWorkspaces: [] });
    }
    document.getElementById('inputClassesPath').value = '';
    if (scanData?.ok) {
        await scanCurrentWorkspace({
            classesPathOverride: '',
            keepStep: currentStep !== 'load'
        });
    }
    showToast('已解除共用類別檔綁定，改用資料夾內本機類別檔', 'info');
}

async function rescanFromLoadedSettings() {
    if (dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    const dirLoaded = document.getElementById('inputImageDirLoaded').value.trim();
    if (dirLoaded) {
        document.getElementById('inputImageDir').value = dirLoaded;
    }
    if (activeModal && activeModal.id === 'pathSettingsModal') {
        closeModal('pathSettingsModal');
    }
    await scanCurrentWorkspace();
}

let scanRequestId = 0;
let pendingWorkspaceScan = false;
async function scanCurrentWorkspace(options = {}) {
    if (options.refreshBoundWorkspace && pendingWorkspaceScan) return;
    const bound = options.refreshBoundWorkspace ? scanData : null;
    const imgDir = bound?.image_dir || (document.getElementById('inputImageDir').value || '').trim();
    const lblDir = imgDir;
    let clsPath = options.classesPathOverride !== undefined
        ? options.classesPathOverride
        : (bound?.classes_path ?? (document.getElementById('inputClassesPath').value || '').trim());
    if (options.classesPathOverride === undefined && scanData && imgDir !== scanData.image_dir) {
        if (clsPath === scanData.classes_path) clsPath = '';
    }

    if (!imgDir) {
        showToast('請先選擇或輸入照片資料夾路徑', 'warn');
        return;
    }

    const requestId = ++scanRequestId;
    pendingWorkspaceScan = true;
    const status = document.getElementById('workspaceLoadStatus');
    status.hidden = false;
    status.textContent = '正在掃描照片與標記檔…';
    try {
        const localSharedCfg = loadLocalSharedClassesCfg();
        const res = await fetch('/api/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                image_dir: imgDir,
                label_dir: lblDir,
                classes_path: clsPath,
                shared_classes_path: localSharedCfg.path || '',
                lock_shared_classes: Boolean(localSharedCfg.lockOverride),
                shared_bound_workspaces: localSharedCfg.boundWorkspaces || []
            })
        });
        const data = await res.json();
        if (requestId !== scanRequestId) return;
        if (!data.ok) {
            // 保留既有狀態，不清空畫面
            status.textContent = data.error || '讀取資料夾失敗，請確認路徑是否存在。';
            return;
        }

        const prevScanData = scanData;
        if (scanData?.workspace_id !== data.workspace_id) {
            masterStem = null;
            activeStem = null;
            copySelectedStems.clear();
            reviewQueue = [];
            similarityMap = {};
            simBannerState = { active: false, warnings: [] };
            recommendedGroups = [];
            currentFilter = 'all';
            document.getElementById('searchInput').value = '';
            document.querySelectorAll('#allScopeFilterChips .f-chip').forEach(button => {
                button.classList.toggle('active', button.dataset.filter === 'all');
                button.setAttribute('aria-pressed', String(button.dataset.filter === 'all'));
            });
            invalidateRemapPreview();
            document.getElementById('applySuccessBanner').style.display = 'none';
            const recBar = document.getElementById('recommendedGroupsBar');
            if (recBar) recBar.style.display = 'none';
            document.getElementById('inputCopyOutputDir').value = '';
            document.getElementById('chkOverwriteExisting').checked = false;
            canvasImageRequest++;
            isSavingCanvas = false;
            activeSavePromise = null;
            pendingSavePayload = null;
            lastSaveFailed = false;
            dirtyCanvasStem = null;
            dirtyCanvasOrigState = null;
            localCanvasUndoStack = [];
            dragAction = null;
            selectedBoxIndex = -1;
        }
        scanData = data;
        if (!scanData.shared_classes_info && !window.YoloWebEngine?.isActive()) {
            scanData.shared_classes_info = computePythonSharedClassesInfo(scanData, prevScanData?.shared_classes_info);
        }
        if (scanData.shared_classes_info?.missing_file) {
            const missingName = scanData.shared_classes_info.file_name || 'classes.txt';
            if (!window.YoloWebEngine?.isActive()) {
                saveLocalSharedClassesCfg({ path: '', fileName: '', lockOverride: false, boundWorkspaces: [] });
            }
            scanData.shared_classes_info.has_binding = false;
            scanData.shared_classes_info.active = false;
            scanData.shared_classes_info.missing_file = false;
            scanData.shared_classes_info.needs_permission = false;
            if (scanData.classes_path && !scanData.classes_file_exists) {
                scanData.classes_path = '';
            }
            showToast(`原本共用的「${missingName}」已被刪除或移動，已自動清除舊設定，請重新選擇類別檔。`, 'warn');
        }
        recordPrevFolderClassesHint(scanData);
        status.hidden = true;
        document.getElementById('inputImageDir').value = data.image_dir;
        document.getElementById('inputImageDirLoaded').value = data.image_dir;
        document.getElementById('inputClassesPath').value = data.classes_path || '';

        // 切換歡迎頁 -> 載入後摘要頁
        document.getElementById('welcomeLandingCard').style.display = 'none';
        document.getElementById('loadedSummaryArea').style.display = 'flex';

        // 選擇預設參考照片 (優先沿用原 masterStem 或 session 紀錄)
        const validRefs = (data.items || []).filter(i => i.is_valid_reference);
        const sessionInfo = data.session || {};
        if (masterStem && validRefs.some(i => i.stem === masterStem)) {
            // keep current masterStem
        } else if (sessionInfo.last_master_stem && validRefs.some(i => i.stem === sessionInfo.last_master_stem)) {
            masterStem = sessionInfo.last_master_stem;
        } else {
            masterStem = validRefs.length > 0 ? validRefs[0].stem : null;
        }

        // 還原佇列與目前選取照片
        if (options.restoreSession && Array.isArray(sessionInfo.review_queue) && sessionInfo.review_queue.length > 0) {
            reviewQueue = sessionInfo.review_queue.filter(st => data.items.some(i => i.stem === st));
        } else if (reviewQueue.length > 0) {
            reviewQueue = reviewQueue.filter(st => data.items.some(i => i.stem === st));
        }

        if (activeStem && data.items.some(i => i.stem === activeStem)) {
            // keep activeStem
        } else if (sessionInfo.last_active_stem && data.items.some(i => i.stem === sessionInfo.last_active_stem)) {
            activeStem = sessionInfo.last_active_stem;
        } else {
            const firstPhoto = data.items.find(i => i.has_image);
            activeStem = firstPhoto ? firstPhoto.stem : null;
        }

        for (const stem of copySelectedStems) {
            if (stem === masterStem || !data.items.some(item => item.stem === stem && item.has_image)) {
                copySelectedStems.delete(stem);
            }
        }

        updateHeaderAndNavBadges();
        renderLoadStepSummary();
        renderClassRemapEditor();

        if (data.summary.photo_count === 0) {
            switchStep('load');
        } else if (options.keepStep) {
            switchStep(currentStep);
        } else {
            reviewScope = 'all';
            switchStep('review');
        }
    } catch (err) {
        console.error(err);
        if (requestId === scanRequestId) {
            status.hidden = false;
            status.textContent = '掃描時連線中斷。請確認工具仍在執行，再重新載入。';
        }
    } finally {
        if (requestId === scanRequestId) pendingWorkspaceScan = false;
    }
}

// ============================================================================
// 頁首、導覽列與步驟 1 摘要渲染
// ============================================================================
function updateHeaderAndNavBadges() {
    if (!scanData || !scanData.ok) return;
    if (!scanData.shared_classes_info && !window.YoloWebEngine?.isActive()) {
        scanData.shared_classes_info = computePythonSharedClassesInfo(scanData);
    }
    const s = scanData.summary;

    // 頁首只顯示資料夾名稱，完整路徑收進彈窗
    const folderBox = document.getElementById('headerFolderBox');
    const folderBtn = document.getElementById('headerFolderName');
    folderBox.style.display = 'inline-flex';
    folderBtn.textContent = scanData.folder_name || scanData.image_dir;
    folderBtn.title = `完整路徑：${scanData.image_dir} (點擊查看詳情)`;

    document.getElementById('detailFullImageDir').textContent = scanData.image_dir || '';
    document.getElementById('detailFullClassesPath').textContent = scanData.classes_path || '（未找到 classes.txt）';

    // 啟用步驟與工具按鈕
    document.getElementById('navBtnApply').disabled = (s.photo_count === 0);
    document.getElementById('navBtnReview').disabled = (s.photo_count === 0);
    document.getElementById('btnUtilRemap').disabled = (s.photo_count === 0);

    const hasUndo = Boolean(
        (dirtyCanvasStem && localCanvasUndoStack.length > 0) ||
        (scanData.last_backup && scanData.last_backup.backup_id)
    );
    document.getElementById('btnQuickUndo').disabled = !hasUndo;

    // 導覽列數字提醒
    const badgeUnlabeled = document.getElementById('navBadgeUnlabeled');
    if (s.unlabeled_count > 0) {
        badgeUnlabeled.style.display = 'inline-block';
        badgeUnlabeled.textContent = `未標記 ${s.unlabeled_count}`;
    } else {
        badgeUnlabeled.style.display = 'none';
    }

    const needReviewCnt = s.pending_review_count + s.needs_fix_count;
    const badgePending = document.getElementById('navBadgePending');
    if (needReviewCnt > 0) {
        badgePending.style.display = 'inline-block';
        badgePending.textContent = `待確認 ${needReviewCnt}`;
    } else {
        badgePending.style.display = 'none';
    }
    renderSharedClassesGuidance();
}

function renderLoadStepSummary() {
    if (!scanData || !scanData.ok) return;
    const s = scanData.summary;

    document.getElementById('summaryFolderNameTag').textContent = `資料夾：${scanData.folder_name}`;

    const clsTag = document.getElementById('summaryClassesTag');
    clsTag.textContent = scanData.classes_file_exists ? '' : '缺少類別檔';
    clsTag.hidden = scanData.classes_file_exists;

    // 主要行動摘要橫幅 (Action Hero Card)
    const headlineEl = document.getElementById('actionHeroHeadline');
    const subtextEl = document.getElementById('actionHeroSubtext');
    const btnsEl = document.getElementById('actionHeroButtons');

    if (s.photo_count === 0) {
        headlineEl.textContent = '沒有找到照片';
        subtextEl.textContent = '';
        btnsEl.innerHTML = `
            <button class="btn btn-primary btn-lg" onclick="pickAndLoadFolder()">重選資料夾</button>
        `;
    } else if (s.reference_candidate_count === 0) {
        headlineEl.textContent = `缺少參考照片`;
        subtextEl.textContent = '請先標記一張照片。';
        btnsEl.innerHTML = `
            <button class="btn btn-primary btn-lg" onclick="startLabelingFirstPhoto()">標記第 1 張照片</button>
            <button class="btn btn-secondary" onclick="switchStep('review')">前往檢視照片</button>
        `;
    } else if (s.unlabeled_count > 0) {
        headlineEl.textContent = `${s.unlabeled_count} 張未標記`;
        subtextEl.textContent = `共 ${s.photo_count} 張照片`;
        btnsEl.innerHTML = `
            <button class="btn btn-primary btn-xl" onclick="startBatchApplyForUnlabeled()">
                前往批次套用 →
            </button>
            <button class="btn btn-secondary" onclick="switchStep('review')">直接檢視照片</button>
        `;
    } else if (s.pending_review_count + s.needs_fix_count > 0) {
        const todoCnt = s.pending_review_count + s.needs_fix_count;
        headlineEl.textContent = `${todoCnt} 張待確認`;
        subtextEl.textContent = `共 ${s.photo_count} 張照片`;
        btnsEl.innerHTML = `
            <button class="btn btn-primary btn-xl" onclick="startReviewForPendingItems()">
                檢查這 ${todoCnt} 張 →
            </button>
            <button class="btn btn-secondary" onclick="switchStep('apply')">前往批次套用</button>
        `;
    } else {
        headlineEl.textContent = `已確認全部 ${s.photo_count} 張`;
        subtextEl.textContent = ``;
        btnsEl.innerHTML = `
            <button class="btn btn-secondary" onclick="switchStep('review')">檢視照片</button>
        `;
    }

    // 雙面向統計卡片（所有百分比皆附帶分母）
    document.getElementById('statPhotoCnt').textContent = s.photo_count;
    document.getElementById('statRevUnlabeled').textContent = s.unlabeled_count;
    document.getElementById('statRevPending').textContent = s.pending_review_count;
    document.getElementById('statRevNeedsFix').textContent = s.needs_fix_count;
    document.getElementById('statRevConfirmed').textContent = s.confirmed_count;

    // 同類問題分組清單
    renderIssueGroups(scanData.issue_groups || []);
}

function renderIssueGroups(groups) {
    const container = document.getElementById('issueGroupsContainer');
    if (!container) return;

    if (!groups || groups.length === 0) {
        const summary = scanData?.summary || {};
        const pending = Math.max(0, (summary.photo_count || 0) - (summary.confirmed_count || 0));
        const message = !summary.photo_count ? '目前沒有可檢查的照片。'
            : pending ? `格式正常 · ${pending} 張待確認或修正`
            : '所有照片皆已確認完成。';
        container.innerHTML = `
            <div class="project-normal-note">
                ${message}
            </div>
        `;
        return;
    }

    container.innerHTML = groups.map((g, idx) => {
        let badgeClass = 'badge-info';
        let badgeSymbol = '[待處理]';
        if (g.level === 'error') { badgeClass = 'badge-err'; badgeSymbol = '[✕ 錯誤]'; }
        else if (g.level === 'warning') { badgeClass = 'badge-warn'; badgeSymbol = '[! 提醒]'; }

        const filesHtml = (g.stems || []).map(st => {
            const item = scanData.items.find(i => i.stem === st);
            const fname = item ? (item.image_name || item.label_name) : st;
            const statusText = item ? `${item.format_label} · ${item.review_label}` : '';
            return `
                <div class="issue-file-row">
                    <span><strong>${escapeHtml(fname)}</strong> <span class="muted-text">(${escapeHtml(statusText)})</span></span>
                    <button class="btn-xs" onclick="jumpToSingleItemInReview('${escapeJsStr(st)}')">檢視</button>
                </div>
            `;
        }).join('');

        return `
            <div class="issue-group-item">
                <div class="issue-group-header">
                    <div>
                        <div class="issue-group-title-box">
                            <span class="badge ${badgeClass}">${badgeSymbol} ${g.count} 項</span>
                            <span class="issue-group-title">${escapeHtml(g.title)}</span>
                        </div>
                        
                    </div>
                    <div class="issue-group-actions">
                        <button class="btn-xs" onclick="toggleIssueGroupFiles('issueFiles_${idx}')">
                            查看檔案
                        </button>
                        <button class="btn btn-primary btn-sm" onclick="handleIssueGroupAction('${escapeJsStr(g.action_type)}', ${idx})">
                            ${escapeHtml(g.action_label)}
                        </button>
                    </div>
                </div>
                <div id="issueFiles_${idx}" class="issue-group-files">
                    <p class="muted-text">${escapeHtml(g.description)}</p>
                    ${filesHtml}
                </div>
            </div>
        `;
    }).join('');
}

function toggleIssueGroupFiles(elemId) {
    const el = document.getElementById(elemId);
    if (el) el.classList.toggle('open');
}

function handleIssueGroupAction(actionType, groupIdx) {
    const group = (scanData.issue_groups || [])[groupIdx];
    if (!group) return;

    if (actionType === 'go_batch_apply') {
        startBatchApplyForUnlabeled();
    } else if (actionType === 'open_class_remap') {
        openModal('remapModal');
    } else if (actionType === 'review_group_items') {
        const stems = (group.stems || []).filter(st => scanData.items.some(i => i.stem === st && i.has_image));
        presetReviewFilter('all');
        if (stems.length > 0) activeStem = stems[0];
        switchStep('review');
    }
}

// 預先設定檢視清單的快速篩選（不立即重繪，供切換頁面前使用）
function presetReviewFilter(filterName) {
    currentFilter = filterName;
    reviewScope = 'all';
    const search = document.getElementById('searchInput');
    if (search) search.value = '';
    document.querySelectorAll('#allScopeFilterChips .f-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filterName);
        btn.setAttribute('aria-pressed', String(btn.dataset.filter === filterName));
    });
}

function startBatchApplyForUnlabeled() {
    if (!scanData) return;
    document.getElementById('applySuccessBanner').style.display = 'none';
    switchStep('apply');
}

function startReviewForPendingItems() {
    if (!scanData) return;
    presetReviewFilter('pending_review');
    const first = scanData.items.find(i => i.has_image && (i.review_status === 'pending_review' || i.review_status === 'needs_fix'));
    if (first) activeStem = first.stem;
    switchStep('review');
}

function jumpToSingleItemInReview(stem) {
    presetReviewFilter('all');
    activeStem = stem;
    switchStep('review');
}

function startLabelingFirstPhoto() {
    if (!scanData || !scanData.items.length) return;
    const firstPhoto = scanData.items.find(i => i.has_image);
    if (!firstPhoto) return;
    activeStem = firstPhoto.stem;
    switchStep('review');
    toggleDrawBoxMode(true);
}

// ============================================================================
// 步驟 2：批次套用 (1. 選參考照片 -> 2. 選要套用的照片 -> 3. 預覽並建立標記草稿)
// ============================================================================
function renderBatchApplyStep() {
    if (!scanData || !scanData.ok) return;
    renderReferenceSelector();
    renderClassFilterCheckboxes();
    renderCopyPhotoGrid();
    runMasterCopyPreview();
}

function renderReferenceSelector() {
    const container = document.getElementById('referenceSelectorArea');
    const validRefs = (scanData.items || []).filter(i => i.is_valid_reference);

    if (validRefs.length === 0) {
        container.innerHTML = `
            <div style="color:var(--status-red);font-weight:700;">
                缺少可用的參考照片。
            </div>
            <button class="btn btn-primary btn-sm" onclick="startLabelingFirstPhoto()">標記第 1 張照片</button>
        `;
        return;
    }

    if (!masterStem || !validRefs.some(i => i.stem === masterStem)) {
        masterStem = validRefs[0].stem;
    }
    const curRef = validRefs.find(i => i.stem === masterStem);
    const optionsHtml = validRefs.map(item => `
        <option value="${escapeHtml(item.stem)}" ${item.stem === masterStem ? 'selected' : ''}>
            ${escapeHtml(item.image_name)}
        </option>
    `).join('');

    const classSummary = curRef
        ? Array.from(new Set(curRef.boxes.map(b => b.class_name))).join(', ')
        : '';

    container.innerHTML = `
        <div class="ref-thumb-box">
            <img class="ref-thumb-img" src="${workspaceImage(masterStem, true)}" alt="參考照片縮圖">
            <div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <select class="form-select-sm" style="font-weight:700;min-width:0;width:100%;" onchange="changeReferencePhoto(this.value)">
                        ${optionsHtml}
                    </select>
                </div>
                <div class="muted-text" style="margin-top:4px;">
                    ${curRef.box_count} 框 · ${escapeHtml(classSummary)}
                </div>
            </div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="jumpToSingleItemInReview('${escapeJsStr(masterStem)}')">
            檢視參考照片
        </button>
    `;
}

function changeReferencePhoto(newStem) {
    masterStem = newStem;
    copySelectedStems.delete(newStem);
    similarityMap = {};
    document.getElementById('recommendedGroupsBar').style.display = 'none';
    renderBatchApplyStep();
    saveSessionProgress();
}

function renderClassFilterCheckboxes() {
    const wrap = document.getElementById('copyClassFilterCheckboxes');
    const curRef = scanData.items.find(i => i.stem === masterStem);
    if (!curRef || !curRef.boxes.length) {
        wrap.innerHTML = '<span class="muted-text">無可篩選類別</span>';
        return;
    }

    const classCounts = {};
    curRef.boxes.forEach(b => {
        classCounts[b.class_id] = (classCounts[b.class_id] || 0) + 1;
    });

    wrap.innerHTML = Object.keys(classCounts).map(cid => {
        const cname = scanData.classes[cid] || `類別#${cid}`;
        return `
            <label class="checkbox-inline">
                <input type="checkbox" class="copy-cls-chk" value="${cid}" checked onchange="runMasterCopyPreview()">
                <span>[${cid}] ${escapeHtml(cname)} (${classCounts[cid]}框)</span>
            </label>
        `;
    }).join('');
}

let copyGridRenderedCount = 120;
let copyGridScrollBound = false;

function buildCopyPhotoCardHtml(item) {
    const isRef = item.stem === masterStem;
    const isSel = copySelectedStems.has(item.stem);
    const simInfo = similarityMap[item.stem];

    let cardCls = 'photo-card';
    let roleTag = '';
    if (isRef) {
        cardCls += ' is-reference';
        roleTag = `<span class="card-role-tag ref">參考</span>`;
    } else if (isSel) {
        cardCls += ' is-selected';
        roleTag = `<span class="card-role-tag sel">已選</span>`;
    }

    const statusBadge = item.has_label
        ? `<span class="badge ${item.review_status === 'confirmed' ? 'badge-ok' : 'badge-warn'}">${escapeHtml(item.review_label)} (${item.box_count}框)</span>`
        : `<span class="badge badge-info">未標記</span>`;

    const simHtml = (!isRef && simInfo)
        ? `<div style="font-size:var(--type-small);color:var(--primary-blue);font-weight:600;">${escapeHtml(simInfo.reason)}</div>`
        : '';

    return `
        <button type="button" class="${cardCls}" data-copy-stem="${escapeHtml(item.stem)}" aria-pressed="${isSel}" aria-disabled="${isRef}" onclick="togglePhotoCardSelection('${escapeJsStr(item.stem)}')">
            <div class="photo-card-thumb">
                <img src="${workspaceImage(item.stem)}" loading="lazy" alt="${escapeHtml(item.image_name)}">
                ${roleTag}
            </div>
            <div class="photo-card-body">
                <div class="photo-card-title" title="${escapeHtml(item.image_name)}">${escapeHtml(item.image_name)}</div>
                <div>${statusBadge}</div>
                ${simHtml}
            </div>
        </button>
    `;
}

let simBannerState = { active: false, warnings: [] };

function updateRecommendedGroupsStrip() {
    const strip = document.getElementById('recommendedGroupsBar');
    if (!strip) return;
    if (!simBannerState.active) {
        strip.style.display = 'none';
        strip.innerHTML = '';
        return;
    }
    const totalPhotos = (scanData?.items || []).filter(i => i.has_image).length;
    strip.style.display = 'flex';
    strip.innerHTML = `
        <span style="font-weight:700;color:var(--status-amber);">
            已選 ${copySelectedStems.size} / ${totalPhotos} 張相似照片。
        </span>
    `;
    if (Array.isArray(simBannerState.warnings) && simBannerState.warnings.length) {
        strip.innerHTML += `<span class="text-amber">${escapeHtml(simBannerState.warnings.join('；'))}</span>`;
    }
}

function renderCopyPhotoGrid(resetCount = true) {
    const grid = document.getElementById('copyPhotoGrid');
    const photos = (scanData.items || []).filter(i => i.has_image);
    document.getElementById('copyTargetCount').textContent = copySelectedStems.size;
    const totalCountEl = document.getElementById('copyTotalPhotoCount');
    if (totalCountEl) totalCountEl.textContent = photos.length;
    updateRecommendedGroupsStrip();

    const focusedStem = document.activeElement?.dataset?.copyStem;
    const vThreshold = window.YOLO_SHARED_RULES?.thresholds?.virtual_list_threshold || 150;

    if (photos.length <= vThreshold) {
        grid.innerHTML = photos.map(buildCopyPhotoCardHtml).join('');
    } else {
        if (resetCount) copyGridRenderedCount = 120;
        const slice = photos.slice(0, copyGridRenderedCount);
        grid.innerHTML = slice.map(buildCopyPhotoCardHtml).join('');
        if (!copyGridScrollBound) {
            copyGridScrollBound = true;
            grid.addEventListener('scroll', () => {
                const allPhotos = (scanData?.items || []).filter(i => i.has_image);
                if (allPhotos.length <= vThreshold || copyGridRenderedCount >= allPhotos.length) return;
                if (grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 240) {
                    const prevCount = copyGridRenderedCount;
                    copyGridRenderedCount = Math.min(allPhotos.length, copyGridRenderedCount + 120);
                    const nextChunk = allPhotos.slice(prevCount, copyGridRenderedCount);
                    grid.insertAdjacentHTML('beforeend', nextChunk.map(buildCopyPhotoCardHtml).join(''));
                }
            }, { passive: true });
        }
    }
    if (focusedStem) Array.from(grid.querySelectorAll('[data-copy-stem]')).find(el => el.dataset.copyStem === focusedStem)?.focus();
}

function togglePhotoCardSelection(stem) {
    if (stem === masterStem) {
        showToast('此張是目前選定的「參考照片」，無須複製給自己。', 'info');
        return;
    }
    if (copySelectedStems.has(stem)) {
        copySelectedStems.delete(stem);
    } else {
        copySelectedStems.add(stem);
    }
    renderCopyPhotoGrid();
    runMasterCopyPreview();
}

function selectAllUnlabeledForCopy() {
    copySelectedStems.clear();
    (scanData.items || []).forEach(item => {
        if (item.has_image && !item.has_label && item.stem !== masterStem) {
            copySelectedStems.add(item.stem);
        }
    });
    renderCopyPhotoGrid();
    runMasterCopyPreview();
}

function clearAllCopyTargets() {
    copySelectedStems.clear();
    renderCopyPhotoGrid();
    runMasterCopyPreview();
}

async function runSimilarPhotoFinder() {
    if (!masterStem) {
        showToast('請先選擇一張參考照片', 'warn');
        return;
    }
    const method = 'visual';
    const thresholdValue = parseFloat(document.getElementById('numSimThreshold').value);
    const threshold = Number.isFinite(thresholdValue) ? thresholdValue : 0.75;

    try {
        const res = await workspaceFetch('/api/group', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                method,
                threshold,
                master_stem: masterStem
            })
        });
        const data = await res.json();
        if (!data.ok) {
            showToast(data.error || '找出相似照片失敗', 'error');
            return;
        }

        similarityMap = {};
        let matchedStems = [];
        recommendedGroups = data.groups || [];

        recommendedGroups.forEach(g => {
            const members = Array.isArray(g.members) ? g.members : [
                ...(g.recommended_master ? [{ stem: g.recommended_master, similarity: 1, reason: '參考照片' }] : []),
                ...(g.targets || [])
            ];
            const hasMaster = members.some(m => m.stem === masterStem);
            members.forEach(m => {
                similarityMap[m.stem] = {
                    similarity: m.similarity,
                    reason: m.reason
                };
                if (hasMaster && m.stem !== masterStem && m.similarity >= threshold) {
                    matchedStems.push(m.stem);
                }
            });
        });

        // 自動勾選與參考照片同組且符合門檻的未標記照片
        const overwrite = document.getElementById('chkOverwriteExisting').checked;
        copySelectedStems.clear();
        matchedStems.forEach(st => {
            const item = scanData.items.find(i => i.stem === st);
            if (item && (!item.has_label || overwrite)) {
                copySelectedStems.add(st);
            }
        });

        simBannerState = { active: true, warnings: Array.isArray(data.warnings) ? data.warnings : [] };
        renderCopyPhotoGrid();
        runMasterCopyPreview();
    } catch (e) {
        showToast('執行相似照片比對時發生錯誤', 'error');
    }
}

function getSelectedCopyClassIds() {
    const chks = document.querySelectorAll('.copy-cls-chk');
    if (!chks.length) return null;
    const selected = [];
    chks.forEach(c => {
        if (c.checked) selected.push(parseInt(c.value, 10));
    });
    return selected;
}

let copyPreviewRequest = 0;
let copyInProgress = false;
let validatedCopyPayload = null;

function currentCopyPayload() {
    return {
        master_stem: masterStem,
        target_stems: Array.from(copySelectedStems),
        overwrite: document.getElementById('chkOverwriteExisting').checked,
        output_dir: document.getElementById('inputCopyOutputDir').value.trim() || null,
        selected_classes: getSelectedCopyClassIds()
    };
}

function copyPreviewMessage(message, action = '') {
    const el = document.getElementById('copyPreviewStatus');
    el.replaceChildren();
    const text = document.createElement('span');
    text.textContent = message;
    el.appendChild(text);
    if (action === 'retry') {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn-link';
        button.textContent = '重試預覽';
        button.onclick = runMasterCopyPreview;
        el.appendChild(button);
    }
}

function renderWritePreview(items) {
    if (!items.length) return '<p class="empty-state">請選擇要套用的照片。</p>';
    return '<ul class="write-preview-list">' + items.map(p => {
        const labels = {will_create: ['新增', 'badge-ok'], will_overwrite: ['覆蓋', 'badge-warn'],
            skip_existing: ['略過', 'badge-neutral'], skip_self: ['略過', 'badge-neutral']};
        const [label, style] = labels[p.action] || ['阻擋', 'badge-err'];
        const detail = [...(p.warnings || [])];
        if (p.action !== 'will_create' && p.reason) detail.unshift(p.reason);
        return `<li class="write-preview-item">
            <details class="preview-file"><summary title="展開完整檔名">${escapeHtml(p.image_name)}</summary>
                <div class="full-file-name">${escapeHtml(p.image_name)}</div></details>
            <span class="badge ${style}">${label}</span>
            ${detail.length ? `<p class="preview-reason">${escapeHtml(detail.join('；'))}</p>` : ''}
        </li>`;
    }).join('') + '</ul>';
}

async function runMasterCopyPreview() {
    if (copyInProgress) return;
    const requestId = ++copyPreviewRequest;
    validatedCopyPayload = null;
    const summaryBox = document.getElementById('applySummaryCards');
    const previewContainer = document.getElementById('masterCopyPreviewContainer');
    const execBtn = document.getElementById('btnExecuteMasterCopy');
    execBtn.disabled = true; execBtn.textContent = '建立草稿';
    copyPreviewMessage('正在更新寫入預覽…');
    if (!masterStem) {
        summaryBox.textContent = '尚無可用的批次參考';
        previewContainer.innerHTML = '<p class="empty-state">先準備一張已有標記的照片。</p>';
        copyPreviewMessage('請先選擇有效的批次參考照片。');
        return;
    }
    const payload = currentCopyPayload();
    const workspace = scanData.workspace_id;
    try {
        const res = await workspaceFetch('/api/master_copy/preview', {
            method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (requestId !== copyPreviewRequest || copyInProgress || workspace !== scanData?.workspace_id) return;
        if (!data.ok) {
            summaryBox.textContent = '無法取得寫入預覽'; previewContainer.replaceChildren();
            copyPreviewMessage(data.error || '請檢查資料夾與設定後重試。', 'retry'); return;
        }
        const sum = data.summary;
        const willApplyCnt = sum.will_create_count + sum.will_overwrite_count;
        summaryBox.innerHTML = `<strong>新增 ${sum.will_create_count} · 覆蓋 ${sum.will_overwrite_count} · 略過 ${sum.will_skip_count}</strong>
            <div class="muted-text">既有標記：${payload.overwrite ? '允許覆蓋（原檔會備份）' : '保留'}</div>
            <details class="output-path"><summary>輸出：${escapeHtml(data.output_dir_name || scanData.folder_name)}</summary>
                <div class="full-file-name">${escapeHtml(payload.output_dir || scanData.image_dir || data.output_dir_name)}</div></details>`;
        previewContainer.innerHTML = renderWritePreview(data.preview_items);
        const blocking = data.blocking_reasons || [];
        if (willApplyCnt > 0 && !blocking.length) {
            validatedCopyPayload = {workspace, payload};
            execBtn.disabled = false; execBtn.textContent = `建立 ${willApplyCnt} 份草稿`;
            copyPreviewMessage(sum.will_overwrite_count ? '將覆蓋列出的既有標記，原檔會備份。' : '建立後請逐張確認框位。');
        } else if (!payload.target_stems.length) {
            copyPreviewMessage('請先選擇要套用的照片。');
        } else if (!payload.overwrite && sum.will_skip_count === payload.target_stems.length && !willApplyCnt) {
            copyPreviewMessage('已選照片都有標記，目前會全部保留。');
        } else {
            copyPreviewMessage(blocking.join('；').replaceAll('進階設定', '套用設定') || '沒有可建立的草稿，請檢查設定。');
        }
    } catch (e) {
        if (requestId !== copyPreviewRequest || workspace !== scanData?.workspace_id) return;
        previewContainer.replaceChildren();
        copyPreviewMessage('預覽失敗，請重試。', 'retry');
    }
}

async function runMasterCopyExecute() {
    const button = document.getElementById('btnExecuteMasterCopy');
    if (copyInProgress || button.disabled || !masterStem || copySelectedStems.size === 0) return;

    const payload = currentCopyPayload();
    if (!validatedCopyPayload || validatedCopyPayload.workspace !== scanData.workspace_id ||
        JSON.stringify(validatedCopyPayload.payload) !== JSON.stringify(payload)) {
        await runMasterCopyPreview();
        return;
    }
    const targetStems = payload.target_stems;
    const overwrite = payload.overwrite;
    const outputDir = payload.output_dir;
    const selectedClasses = payload.selected_classes;
    validatedCopyPayload = null;

    const workspace = scanData.workspace_id;
    const banner = document.getElementById('applySuccessBanner');
    const controls = document.querySelector('.apply-columns');
    copyInProgress = true;
    controls.inert = true;
    banner.classList.remove('has-failures');
    button.disabled = true;
    button.textContent = '正在建立標記草稿…';
    banner.style.display = 'flex';
    banner.textContent = '正在寫入標記檔並建立備份…';
    try {
        const smartAlign = document.getElementById('chkSmartAlign')
            ? Boolean(document.getElementById('chkSmartAlign').checked)
            : true;
        const res = await workspaceFetch('/api/master_copy/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                master_stem: masterStem,
                target_stems: targetStems,
                overwrite,
                output_dir: outputDir || null,
                selected_classes: selectedClasses,
                smart_align: smartAlign
            })
        });
        const data = await res.json();
        if (workspace !== scanData?.workspace_id) return;
        if (!data.scan?.ok || !data.results) {
            banner.classList.add('has-failures');
            banner.textContent = data.error || '批次套用失敗，請重新掃描確認檔案狀態。';
            return;
        }

        scanData = data.scan;
        const result = data.results;
        const processedStems = result.processed_stems || [];
        const canReview = result.in_place && processedStems.length > 0;
        if (canReview) {
            presetReviewFilter('pending_review');
            activeStem = processedStems[0];
        }
        processedStems.forEach(stem => copySelectedStems.delete(stem));

        updateHeaderAndNavBadges();
        renderLoadStepSummary();
        renderCopyPhotoGrid();

        banner.classList.toggle('has-failures', result.failed_count > 0);
        const failures = (result.failed || []).map(item =>
            `<li><strong>${escapeHtml(item.stem)}</strong> — ${escapeHtml(item.error)}</li>`
        ).join('');
        banner.innerHTML = `
            <div>
                <strong class="${result.failed_count ? 'text-amber' : 'text-green'}">
                    ${result.failed_count ? '部分寫入失敗' : '批次套用完成'}
                </strong>
                <div>已寫入 ${result.success_count} 張 · 略過 ${result.skipped_count} 張 · 失敗 ${result.failed_count} 張</div>
                <details><summary>輸出資料夾</summary><code id="copyResultPath">${escapeHtml(result.output_dir)}</code></details>
                ${failures ? `<ul class="copy-failure-list">${failures}</ul><p>修正後可重試失敗項目。</p>` : ''}
            </div>
            ${canReview
                ? `<button class="btn btn-primary" onclick="startReviewQueueNow()">檢查這 ${processedStems.length} 張</button>`
                : `<button class="btn btn-secondary" onclick="openInExplorer('copyResultPath')">開啟輸出資料夾</button>`}
        `;
    } catch {
        if (workspace === scanData?.workspace_id) {
            banner.classList.add('has-failures');
            banner.textContent = '執行時連線中斷。請重新掃描確認檔案狀態，再決定是否重試。';
        }
    } finally {
        copyInProgress = false;
        controls.inert = false;
        if (currentStep === 'apply') runMasterCopyPreview();
    }
}

function startReviewQueueNow() {
    presetReviewFilter('pending_review');
    switchStep('review');
}

// ============================================================================
// 步驟 3：檢查與微調 (最大化畫布、佇列導向、明確儲存狀態與確認並下一張)
// ============================================================================
let appliedReviewSearch = '';
function canChangeReviewSelection() {
    if (isSavingCanvas || lastSaveFailed || reviewUpdatePending || dragAction) {
        showToast('請先完成儲存；失敗時可點擊儲存狀態重試。', 'warn');
        return false;
    }
    return true;
}
function refreshReviewSelection() {
    const previous = activeStem;
    ensureValidActiveItemForReview();
    if (activeStem !== previous) { selectedBoxIndex = -1; dragAction = null; }
    appliedReviewSearch = document.getElementById('searchInput').value;
    renderStudioFileList();
    renderInspectorAndCanvas();
}
async function applyReviewSearch() {
    if (!canChangeReviewSelection()) {
        document.getElementById('searchInput').value = appliedReviewSearch;
        return;
    }
    if (dirtyCanvasStem) {
        const nextList = getActiveReviewItemsList();
        if (!nextList.some(i => i.stem === dirtyCanvasStem)) {
            const flushed = await flushUnsavedCanvasDraftIfNeeded();
            if (!flushed) {
                document.getElementById('searchInput').value = appliedReviewSearch;
                return;
            }
        }
    }
    refreshReviewSelection();
}
async function resetReviewFilters() {
    if (!canChangeReviewSelection()) return;
    if (dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    document.getElementById('searchInput').value = '';
    currentFilter = 'all';
    document.querySelectorAll('#allScopeFilterChips .f-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === 'all');
        btn.setAttribute('aria-pressed', String(btn.dataset.filter === 'all'));
    });
    setReviewScope('all');
    document.getElementById('searchInput').focus();
}
async function setReviewScope() {
    // 已取消「本次佇列／全部項目」分類：清單一律顯示全部照片，改由快速篩選縮小範圍
    if (!canChangeReviewSelection()) return;
    if (dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    reviewScope = 'all';
    refreshReviewSelection();
}

async function applyQuickFilter(filterName) {
    if (!canChangeReviewSelection()) return;
    if (dirtyCanvasStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    currentFilter = filterName;
    document.querySelectorAll('#allScopeFilterChips .f-chip').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filterName);
        btn.setAttribute('aria-pressed', String(btn.dataset.filter === filterName));
    });
    refreshReviewSelection();
}

function getActiveReviewItemsList() {
    if (!scanData || !scanData.items) return [];
    const q = (document.getElementById('searchInput')?.value || '').trim().toLowerCase();

    let list = scanData.items.filter(item => {
        if (currentFilter === 'pending_review') return item.review_status === 'pending_review' || item.review_status === 'needs_fix';
        if (currentFilter === 'unlabeled') return item.review_status === 'unlabeled';
        if (currentFilter === 'confirmed') return item.review_status === 'confirmed';
        return true;
    });

    if (q) {
        list = list.filter(i =>
            i.stem.toLowerCase().includes(q) ||
            (i.image_name || '').toLowerCase().includes(q)
        );
    }
    return list;
}

function ensureValidActiveItemForReview() {
    if (!scanData || !scanData.items.length) { activeStem = null; return; }
    reviewScope = 'all';
    const list = getActiveReviewItemsList();
    if (!list.length) activeStem = null;
    else if (!activeStem || !list.some(i => i.stem === activeStem)) activeStem = list[0].stem;
}

let studioVirtualScrollBound = false;
let lastVirtualScrolledStem = null;

function buildStudioListItemHtml(item, idx) {
    const isAct = item.stem === activeStem;
    const isRef = item.stem === masterStem;

    let revBadge = `<span class="badge badge-warn">[!] 待確認</span>`;
    if (item.review_status === 'confirmed') revBadge = `<span class="badge badge-ok">[✓] 已確認</span>`;
    else if (item.review_status === 'needs_fix') revBadge = `<span class="badge badge-err">[!] 需修正</span>`;
    else if (item.review_status === 'unlabeled') revBadge = `<span class="badge badge-info">未標記</span>`;

    const fmtWarn = item.has_blocking_error
        ? `<span class="text-red" style="font-weight:700;">[✕ ${escapeHtml(item.format_label)}]</span>`
        : '';

    return `
        <button type="button" class="review-list-item ${isAct ? 'active' : ''} ${isRef ? 'is-reference' : ''}" data-review-stem="${escapeHtml(item.stem)}" aria-current="${isAct ? 'true' : 'false'}" onclick="selectReviewItem('${escapeJsStr(item.stem)}')">
            <div class="r-item-top">
                <span class="r-item-name" title="${escapeHtml(item.image_name || item.stem)}">
                    ${idx + 1}. ${escapeHtml(item.image_name || item.stem)}
                </span>
            </div>
            <div class="r-item-sub">${revBadge}${isRef ? '<span class="ref-badge">★ 參考照片</span>' : ''}<span>${item.box_count} 框</span></div>
            ${fmtWarn ? `<div class="list-error">${fmtWarn}</div>` : ''}
        </button>
    `;
}

function renderStudioFileList(fromScroll = false) {
    if (!scanData || !scanData.ok) return;

    const list = getActiveReviewItemsList();
    const container = document.getElementById('studioFileList');
    const focusedStem = document.activeElement?.dataset?.reviewStem;
    if (list.length === 0) {
        container.innerHTML = `
            <div style="padding:16px;text-align:center;color:var(--text-muted);">
                沒有符合的照片。<br>
                <button class="btn-link" onclick="resetReviewFilters()">清除搜尋與篩選</button>
            </div>
        `;
        return;
    }

    const vThreshold = window.YOLO_SHARED_RULES?.thresholds?.virtual_list_threshold || 150;
    if (list.length <= vThreshold) {
        container.innerHTML = list.map((item, idx) => buildStudioListItemHtml(item, idx)).join('');
        if (focusedStem) Array.from(container.querySelectorAll('[data-review-stem]')).find(el => el.dataset.reviewStem === focusedStem)?.focus();
        container.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
        return;
    }

    // 大資料集 (2,000+ 張照片) 視窗化虛擬捲動 (Virtual Windowed List)
    const ROW_EST_HEIGHT = 72;
    if (!fromScroll && activeStem && lastVirtualScrolledStem !== activeStem) {
        const activeIdx = list.findIndex(i => i.stem === activeStem);
        if (activeIdx >= 0) {
            const targetTop = activeIdx * ROW_EST_HEIGHT;
            const viewH = container.clientHeight || 480;
            if (targetTop < container.scrollTop || targetTop + ROW_EST_HEIGHT > container.scrollTop + viewH) {
                container.scrollTop = Math.max(0, targetTop - Math.floor(viewH / 2));
            }
        }
        lastVirtualScrolledStem = activeStem;
    }

    const scrollTop = container.scrollTop || 0;
    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_EST_HEIGHT) - 8);
    const endIdx = Math.min(list.length, startIdx + 36);
    const topPad = startIdx * ROW_EST_HEIGHT;
    const bottomPad = Math.max(0, (list.length - endIdx) * ROW_EST_HEIGHT);

    container.innerHTML =
        `<div style="height:${topPad}px;flex-shrink:0;" aria-hidden="true"></div>` +
        list.slice(startIdx, endIdx).map((item, i) => buildStudioListItemHtml(item, startIdx + i)).join('') +
        `<div style="height:${bottomPad}px;flex-shrink:0;" aria-hidden="true"></div>`;

    if (focusedStem) Array.from(container.querySelectorAll('[data-review-stem]')).find(el => el.dataset.reviewStem === focusedStem)?.focus();

    if (!studioVirtualScrollBound) {
        studioVirtualScrollBound = true;
        let rafPending = false;
        container.addEventListener('scroll', () => {
            if (rafPending) return;
            const curList = getActiveReviewItemsList();
            if (curList.length <= vThreshold) return;
            rafPending = true;
            requestAnimationFrame(() => {
                rafPending = false;
                renderStudioFileList(true);
            });
        }, { passive: true });
    }
}

async function selectReviewItem(stem) {
    if (stem === activeStem) return true;
    if (isSavingCanvas || lastSaveFailed || reviewUpdatePending) {
        showToast('請等待標記儲存完成；若儲存失敗請先點擊重試。', 'warn');
        return false;
    }
    if (dirtyCanvasStem && dirtyCanvasStem !== stem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return false;
    }
    dragAction = null;
    isDrawBoxMode = false;
    canvasHoverPos = null;
    activeStem = stem;
    selectedBoxIndex = -1;
    updateSaveIndicator('saved');
    renderStudioFileList();
    renderInspectorAndCanvas();
    saveSessionProgress();
    return true;
}

function readDisplayPreference(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function saveDisplayPreference(key, value) {
    try { localStorage.setItem(key, value); } catch { /* Display preferences are optional. */ }
}


function updateReviewLayout() {
    const workspace = document.getElementById('reviewWorkspace');
    const sidebar = document.getElementById('reviewLeftSidebar');
    if (!workspace || !sidebar || currentStep !== 'review') return;
    const width = workspace.clientWidth;
    const compact = width < 960;
    workspace.classList.toggle('compact-review', compact);
    workspace.classList.toggle('without-list', sidebar.classList.contains('collapsed'));
    redrawCanvases();
}

function bindResizableSidebar({ handleId, sidebarId, cssVar, storageKey, isRightSide = false }) {
    const handle = document.getElementById(handleId);
    const sidebar = document.getElementById(sidebarId);
    if (!handle || !sidebar) return;
    let redrawFrame;
    const saved = Number(readDisplayPreference(storageKey, '280'));
    let requestedWidth = Number.isFinite(saved) ? Math.max(220, Math.min(520, saved)) : 280;
    function applyWidth(persist = true) {
        const limit = Math.max(220, Math.min(520, Math.floor(window.innerWidth * 0.42)));
        const actual = Math.max(220, Math.min(limit, requestedWidth));
        sidebar.style.setProperty(cssVar, actual + 'px');
        handle.setAttribute('aria-valuemax', String(limit));
        handle.setAttribute('aria-valuenow', String(actual));
        handle.setAttribute('aria-valuetext', actual + ' 像素');
        if (persist) {
            requestedWidth = actual;
            saveDisplayPreference(storageKey, String(actual));
        }
        cancelAnimationFrame(redrawFrame);
        redrawFrame = requestAnimationFrame(updateReviewLayout);
    }
    window.addEventListener('resize', () => applyWidth(false));
    handle.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        handle.focus();
        handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener('pointermove', event => {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const rect = sidebar.getBoundingClientRect();
        requestedWidth = isRightSide
            ? Math.round(rect.right - event.clientX)
            : Math.round(event.clientX - rect.left);
        applyWidth();
    });
    const endDrag = event => {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    handle.addEventListener('keydown', event => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const current = Number(handle.getAttribute('aria-valuenow'));
        const delta = isRightSide
            ? (event.key === 'ArrowLeft' ? 20 : -20)
            : (event.key === 'ArrowRight' ? 20 : -20);
        requestedWidth = event.key === 'Home' ? 220 : event.key === 'End' ? 520 : current + delta;
        applyWidth();
    });
    applyWidth(false);
}

function initPhotoListWidth() {
    bindResizableSidebar({
        handleId: 'photoListResize',
        sidebarId: 'reviewLeftSidebar',
        cssVar: '--photo-list-width',
        storageKey: 'yolo.listWidth',
        isRightSide: false
    });
    bindResizableSidebar({
        handleId: 'boxListResize',
        sidebarId: 'pinnedBoxesSidebar',
        cssVar: '--box-list-width',
        storageKey: 'yolo.boxListWidth',
        isRightSide: true
    });
}

function toggleReviewSidebar(side, button) {
    const sidebar = document.getElementById(side === 'left' ? 'reviewLeftSidebar' : 'reviewRightSidebar');
    const overlay = side === 'right' || window.matchMedia('(max-width: 900px)').matches;
    if (overlay) sidebar.classList.remove('collapsed');
    const visible = overlay ? sidebar.classList.toggle('expanded') : !sidebar.classList.toggle('collapsed');
    const trigger = document.querySelector(`[aria-controls="${sidebar.id}"]`);
    trigger?.setAttribute('aria-expanded', String(visible));
    if (side === 'right' && visible) sidebar.querySelector('.close-review-sidebar')?.focus();
    else if (button && button !== trigger) trigger?.focus();
    setTimeout(updateReviewLayout, 50);
}

function updateSaveIndicator(state, message, retry) {
    const el = document.getElementById('saveStatusIndicator');
    if (!el) return;
    el.className = `save-badge ${state}`;
    el.onclick = null;
    el.disabled = (state !== 'error' && state !== 'unsaved');
    if (state === 'saved') {
        el.textContent = message || '[✓] 已儲存';
        el.title = '已儲存';
    } else if (state === 'saving') {
        el.textContent = message || '[...] 儲存中';
        el.title = '儲存中…';
    } else if (state === 'unsaved') {
        el.textContent = message || '[●] 尚未儲存（按 C 確認儲存）';
        el.title = '點擊暫存草稿，或按 C 確認儲存';
        el.onclick = () => flushUnsavedCanvasDraftIfNeeded();
    } else if (state === 'error') {
        el.textContent = message || '[✕] 儲存失敗（點擊重試）';
        el.title = '點擊重試儲存';
        el.onclick = retry || (() => retryLastFailedSave());
    }
}

function getReviewScopePhotos() {
    return scanData.items.filter(item => item.has_image);
}

function renderInspectorAndCanvas() {
    if (!scanData || !scanData.ok) return;
    const item = scanData.items.find(i => i.stem === activeStem);
    const list = getActiveReviewItemsList();
    const s = scanData.summary;
    if (!isSavingCanvas && !lastSaveFailed && !reviewUpdatePending) {
        if (dirtyCanvasStem && dirtyCanvasStem === activeStem) {
            updateSaveIndicator('unsaved', '[●] 尚未儲存（按 C 確認儲存）');
        } else {
            updateSaveIndicator('saved');
        }
    }

    // 更新頂部進度與統計
    const idxInList = list.findIndex(i => i.stem === activeStem);
    document.getElementById('reviewQueueProgress').textContent = idxInList >= 0 ? `目前 ${idxInList + 1}／${list.length} 張` : '';
    const photos = getReviewScopePhotos();
    const count = status => photos.filter(photo => photo.review_status === status).length;
    const scopeLabel = '全部照片';
    document.getElementById('reviewCountsSummary').textContent =
        `${scopeLabel} · 已確認 ${count('confirmed')}／${photos.length}` +
        (count('needs_fix') ? ` · 需修正 ${count('needs_fix')}` : '');

    // 檢查佇列是否全部確認完成
    const completeBanner = document.getElementById('queueCompletedBanner');
    if (photos.length && photos.every(photo => photo.review_status === 'confirmed')) {
        completeBanner.style.display = 'flex';
        const remaining = scanData.items.filter(photo => photo.has_image && photo.review_status !== 'confirmed');
        const needsFix = remaining.filter(photo => photo.review_status === 'needs_fix').length;
        completeBanner.innerHTML = `<strong>${scopeLabel}已確認完成</strong>
            <span>${remaining.length ? `專案尚有 ${remaining.length} 張未完成${needsFix ? `（${needsFix} 張需修正）` : ''}` : '全部照片已確認'}</span>
            ${remaining.length ? '<button class="btn btn-secondary" onclick="reviewRemainingPhotos()">檢查其餘照片</button>' : ''}`;
    } else completeBanner.style.display = 'none';

    document.getElementById('reviewEmptyState').hidden = !!item;
    document.getElementById('canvasViewport').hidden = !item;
    if (!item) {
        selectedBoxIndex = -1;
        canvasRenderState = null;
        document.getElementById('btnConfirmAndNext').disabled = true;
        document.getElementById('btnConfirmAndNext').textContent = '尚未選取照片';
        document.getElementById('btnConfirmAndNext').title = '請先選取照片';
        document.getElementById('saveStatusIndicator').hidden = true;
        document.getElementById('reviewQueueProgress').textContent = '符合 0 張';
        document.getElementById('itemMetaDetails').textContent = '';
        document.getElementById('itemIssuesList').textContent = '';
        document.getElementById('targetCanvasCaption').textContent = '';
        loadImagesAndDrawCanvas(null);
            document.getElementById('reviewCurrentFileName').title = '';
        document.getElementById('reviewCurrentFileName').textContent = '沒有符合的照片';
        document.getElementById('inspectorBoxCount').textContent = '0';
        document.getElementById('itemBoxesList').textContent = '尚未選取照片';
        document.getElementById('btnDeleteSelectedBox').style.display = 'none';
        return;
    }

    document.getElementById('saveStatusIndicator').hidden = false;
    const fileTitle = document.getElementById('reviewCurrentFileName');
    fileTitle.textContent = item.image_name || item.label_name || item.stem;
    fileTitle.title = fileTitle.textContent;
    const isCurrentRef = item.stem === masterStem;
    document.getElementById('reviewRefBadge').hidden = !isCurrentRef;
    const setMasterBtn = document.getElementById('btnSetMaster');
    if (setMasterBtn) {
        setMasterBtn.classList.toggle('is-current-ref', isCurrentRef);
        setMasterBtn.setAttribute('aria-pressed', String(isCurrentRef));
        setMasterBtn.textContent = isCurrentRef ? '★ 已設為參考' : '設為參考';
    }
    document.getElementById('targetCanvasCaption').textContent =
        `${item.review_label}`;

    // 底部主要按鈕文案：若為 0 框照片，明確提示「確認為無物件照片並下一張 (C)」
    const confirmBtn = document.getElementById('btnConfirmAndNext');
    confirmBtn.hidden = item.box_count === 0;
    confirmBtn.style.display = item.box_count === 0 ? 'none' : '';
    confirmBtn.disabled = !!item.has_blocking_error || item.review_status === 'confirmed';
    const hasNext = list.some(photo => photo.stem !== item.stem && photo.review_status !== 'confirmed');
    if (item.review_status === 'confirmed') {
        confirmBtn.textContent = '已確認';
    } else if (item.has_blocking_error) {
        confirmBtn.textContent = '請先修正格式';
    } else if (item.box_count === 0) {
        confirmBtn.textContent = '';
    } else {
        confirmBtn.textContent = hasNext ? '確認並下一張 (C)' : '確認並完成 (C)';
    }

    confirmBtn.title = confirmBtn.textContent;

    // 右側照片狀態詳情
    const metaEl = document.getElementById('itemMetaDetails');
    metaEl.innerHTML = `
        <div class="meta-kv"><span class="muted-text">檔案名稱</span><strong>${escapeHtml(item.image_name || item.label_name)}</strong></div>
        <div class="meta-kv"><span class="muted-text">檢查進度</span><strong>${escapeHtml(item.review_label)}</strong></div>
        <div class="meta-kv"><span class="muted-text">標記狀態</span><strong>${escapeHtml(item.format_label)}</strong></div>
        <div class="meta-kv"><span class="muted-text">照片尺寸</span><span>${item.img_width} × ${item.img_height}</span></div>
        <div class="meta-kv"><span class="muted-text">套用範本</span><span>${escapeHtml(item.source_master || '手動標記')}</span></div>
    `;

    // 右側診斷訊息
    const issuesEl = document.getElementById('itemIssuesList');
    if (!item.issues || item.issues.length === 0) {
        issuesEl.innerHTML = `
            <div style="color:var(--status-green);font-weight:600;">
                [✓] 檢查正常（共 ${item.box_count} 個框）
            </div>
        `;
    } else {
        issuesEl.innerHTML = item.issues.map(iss => {
            const cls = iss.level === 'error' ? 'text-red' : (iss.level === 'warning' ? 'text-amber' : 'text-blue');
            const sym = iss.level === 'error' ? '[✕ 錯誤]' : (iss.level === 'warning' ? '[! 提醒]' : '[資訊]');
            return `<div class="${cls}"><strong>${sym}</strong> ${escapeHtml(iss.message)}</div>`;
        }).join('');
    }

    // 右側標記框清單與新增／複製工具列
    if (!Array.isArray(item.boxes)) item.boxes = [];
    document.getElementById('inspectorBoxCount').textContent = item.boxes.length;
    const availClasses = getAvailableCanvasClasses();
    if (!availClasses.some(c => c.id === defaultDrawClassId) && availClasses.length > 0) {
        defaultDrawClassId = availClasses[0].id;
    }
    const drawBtn = document.getElementById('btnToggleDrawBox');
    if (drawBtn) {
        drawBtn.classList.toggle('active', isDrawBoxMode);
        drawBtn.setAttribute('aria-pressed', String(isDrawBoxMode));
        drawBtn.textContent = isDrawBoxMode ? '✕ 取消新增 (Esc)' : '＋ 新增框 (W)';
    }
    const tCanvasEl = document.getElementById('targetCanvas');
    const mainWrapEl = document.getElementById('mainCanvasWrapper');
    if (tCanvasEl) {
        tCanvasEl.style.cursor = isDrawBoxMode
            ? 'crosshair'
            : (isCanvasZoomedOrScrollable(mainWrapEl) && selectedBoxIndex < 0 ? 'grab' : 'default');
    }
    const hasSelectedBox = (selectedBoxIndex >= 0 && selectedBoxIndex < item.boxes.length);
    const dupBtn = document.getElementById('btnDuplicateSelectedBox');
    if (dupBtn) {
        dupBtn.style.display = hasSelectedBox ? 'inline-flex' : 'none';
    }
    const delBtn = document.getElementById('btnDeleteSelectedBox');
    if (delBtn) {
        delBtn.style.display = hasSelectedBox ? 'inline-flex' : 'none';
    }

    const boxesEl = document.getElementById('itemBoxesList');
    if (item.boxes.length === 0) {
        boxesEl.innerHTML = `<div class="muted-text">沒有標記框（可點上方「＋ 新增框 (W)」直接在畫布拉框）。</div>`;
    } else {
        boxesEl.innerHTML = item.boxes.map((b, idx) => {
            const color = CLASS_COLORS[b.class_id % CLASS_COLORS.length];
            const isSel = idx === selectedBoxIndex;
            const inlineClsSelect = isSel
                ? `<select class="form-select-sm box-inline-class-select" aria-label="變更標記框類別" onclick="event.stopPropagation()" onchange="changeSelectedBoxClass(${idx}, this.value)">
                    ${availClasses.map(c => `<option value="${c.id}" ${c.id === Number(b.class_id) ? 'selected' : ''}>[${c.id}] ${escapeHtml(c.name)}</option>`).join('')}
                    <option value="__new__">＋ 新增類別...</option>
                   </select>`
                : '';
            return `
                <div role="button" tabindex="0" class="box-row-item ${isSel ? 'selected' : ''}" aria-pressed="${isSel}" onclick="selectBoxFromList(${idx})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectBoxFromList(${idx});}">
                    <div class="box-row-main">
                        <span>
                            <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};margin-right:5px;"></span>
                            ${idx + 1} · ${escapeHtml(b.class_name)}
                        </span>
                        ${inlineClsSelect}
                    </div>
                    ${isSel ? `<div class="box-properties">編號 ${b.class_id} · 寬 ${(b.w * 100).toFixed(1)}% × 高 ${(b.h * 100).toFixed(1)}%</div>` : ''}
                </div>
            `;
        }).join('');
    }

    loadImagesAndDrawCanvas(item);
}

function getDefinedClassesList() {
    const classEntries = [];
    if (scanData?.classes && typeof scanData.classes === 'object') {
        Object.keys(scanData.classes)
            .map(k => parseInt(k, 10))
            .filter(k => Number.isFinite(k))
            .sort((a, b) => a - b)
            .forEach(cid => {
                classEntries.push({ id: cid, name: String(scanData.classes[cid] || `class_${cid}`) });
            });
    }
    return classEntries;
}

function getAvailableCanvasClasses() {
    const classEntries = getDefinedClassesList();
    if (!classEntries.length && Array.isArray(scanData?.items)) {
        const seen = new Map();
        scanData.items.forEach(it => {
            (it.boxes || []).forEach(b => {
                const cid = Number(b.class_id);
                if (Number.isFinite(cid) && !seen.has(cid)) {
                    seen.set(cid, String(b.class_name || `class_${cid}`));
                }
            });
        });
        Array.from(seen.keys()).sort((a, b) => a - b).forEach(cid => {
            classEntries.push({ id: cid, name: seen.get(cid) });
        });
    }
    if (!classEntries.length) {
        classEntries.push({ id: 0, name: 'class_0' });
    }
    return classEntries;
}

function openNewBoxClassModal(editBoxIdx = -1) {
    pendingClassEditBoxIdx = editBoxIdx;
    const inputEl = document.getElementById('inputNewBoxClassName');
    if (inputEl) inputEl.value = '';

    const defined = getDefinedClassesList();
    const wrapEl = document.getElementById('existingClassesQuickWrap');
    const listEl = document.getElementById('existingClassesQuickList');
    if (wrapEl && listEl) {
        if (defined.length > 0) {
            wrapEl.style.display = 'flex';
            listEl.innerHTML = defined.map(c =>
                `<button type="button" class="btn-xs existing-cls-chip" onclick="selectExistingClassInModal('${escapeJsStr(c.name)}')">[${c.id}] ${escapeHtml(c.name)}</button>`
            ).join('');
        } else {
            wrapEl.style.display = 'none';
            listEl.innerHTML = '';
        }
    }

    updateNewBoxClassPreview();
    openModal('newBoxClassModal');
    setTimeout(() => {
        inputEl?.focus();
    }, 20);
}

function updateNewBoxClassPreview() {
    const previewEl = document.getElementById('newBoxClassIdPreview');
    const inputEl = document.getElementById('inputNewBoxClassName');
    if (!previewEl || !inputEl) return;

    const val = inputEl.value.trim();
    const defined = getDefinedClassesList();
    const nextId = defined.length > 0 ? Math.max(...defined.map(c => c.id)) + 1 : 0;
    const matched = defined.find(c => c.name === val);

    if (matched) {
        previewEl.textContent = `將使用類別 #${matched.id}：${matched.name}`;
    } else if (val) {
        previewEl.textContent = `將新增為類別 #${nextId}：${val}`;
    } else {
        previewEl.textContent = '';
    }
}

function selectExistingClassInModal(clsName) {
    const inputEl = document.getElementById('inputNewBoxClassName');
    if (inputEl) {
        inputEl.value = clsName;
        updateNewBoxClassPreview();
    }
    confirmNewBoxClassModal();
}

function handleNewBoxClassInputKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        confirmNewBoxClassModal();
    } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelNewBoxClassModal();
    }
}

function cancelNewBoxClassModal() {
    pendingNewBox = null;
    pendingClassEditBoxIdx = -1;
    closeModal('newBoxClassModal');
    renderInspectorAndCanvas();
}

let isSavingNewClass = false;

async function persistClassesImmediately(classesList) {
    const normalized = Array.isArray(classesList)
        ? classesList.map((c, idx) => String(c || '').trim() || `class_${idx}`)
        : [];
    try {
        const res = await workspaceFetch('/api/save_classes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ classes: normalized })
        });
        const data = await res.json();
        if (!data || !data.ok) {
            showToast(data?.error || '儲存新類別失敗，請確認檔案權限', 'error');
            return false;
        }
        scanData.classes = Array.isArray(data.classes) ? data.classes : normalized;
        if ('classes_file_exists' in data) {
            scanData.classes_file_exists = Boolean(data.classes_file_exists);
        }
        if (data.classes_path) {
            scanData.classes_path = data.classes_path;
            const clsInputEl = document.getElementById('inputClassesPath');
            if (clsInputEl) clsInputEl.value = data.classes_path;
        }
        if ('shared_classes_active' in data && scanData.shared_classes_info) {
            scanData.shared_classes_info.active = Boolean(data.shared_classes_active);
        }
        return true;
    } catch (_) {
        showToast('儲存新類別失敗，請確認連線或檔案狀態', 'error');
        return false;
    }
}

async function confirmNewBoxClassModal() {
    if (isSavingNewClass) return;
    const inputEl = document.getElementById('inputNewBoxClassName');
    const rawName = (inputEl?.value || '').trim();
    if (!rawName) {
        showToast('請輸入新增標記框的類別名稱', 'warn');
        inputEl?.focus();
        return;
    }

    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (!item) {
        cancelNewBoxClassModal();
        return;
    }

    const snap = snapshotItemForUndo(item);
    const defined = getDefinedClassesList();
    const matched = defined.find(c => c.name === rawName);
    let targetId;
    let targetName;
    let isBrandNewClass = false;
    const prevClasses = Array.isArray(scanData.classes) ? [...scanData.classes] : [];
    const prevClassesExists = Boolean(scanData.classes_file_exists);
    const prevClassesPath = scanData.classes_path || '';

    if (matched) {
        targetId = matched.id;
        targetName = matched.name;
    } else {
        isBrandNewClass = true;
        targetId = defined.length > 0 ? Math.max(...defined.map(c => c.id)) + 1 : 0;
        targetName = rawName;
        if (!Array.isArray(scanData.classes)) {
            scanData.classes = [];
        }
        for (let i = 0; i <= targetId; i++) {
            if (!scanData.classes[i]) {
                scanData.classes[i] = i === targetId ? targetName : `class_${i}`;
            }
        }
        scanData.classes[targetId] = targetName;

        isSavingNewClass = true;
        try {
            const ok = await persistClassesImmediately(scanData.classes);
            if (!ok) {
                scanData.classes = prevClasses;
                scanData.classes_file_exists = prevClassesExists;
                scanData.classes_path = prevClassesPath;
                return;
            }
        } finally {
            isSavingNewClass = false;
        }
    }

    if (!Array.isArray(item.boxes)) item.boxes = [];
    if (pendingClassEditBoxIdx >= 0 && pendingClassEditBoxIdx < item.boxes.length) {
        item.boxes[pendingClassEditBoxIdx].class_id = targetId;
        item.boxes[pendingClassEditBoxIdx].class_name = targetName;
        selectedBoxIndex = pendingClassEditBoxIdx;
    } else if (pendingNewBox) {
        item.boxes.push({
            class_id: targetId,
            class_name: targetName,
            xc: pendingNewBox.xc,
            yc: pendingNewBox.yc,
            x_center: pendingNewBox.xc,
            y_center: pendingNewBox.yc,
            w: pendingNewBox.w,
            h: pendingNewBox.h,
            width: pendingNewBox.w,
            height: pendingNewBox.h
        });
        selectedBoxIndex = item.boxes.length - 1;
    } else {
        cancelNewBoxClassModal();
        return;
    }

    defaultDrawClassId = targetId;
    pendingNewBox = null;
    pendingClassEditBoxIdx = -1;
    closeModal('newBoxClassModal');
    markCanvasDraftDirty(item, snap);
    if (isBrandNewClass) {
        renderClassRemapEditor();
        recordPrevFolderClassesHint(scanData);
        showToast(`已新增類別「${targetName}」`, 'success');
    }
    renderSharedClassesGuidance();
}

function toggleDrawBoxMode(forceState) {
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (!item || !item.has_image) return;
    isDrawBoxMode = typeof forceState === 'boolean' ? forceState : !isDrawBoxMode;
    if (!isDrawBoxMode) {
        canvasHoverPos = null;
        if (dragAction?.mode === 'create') dragAction = null;
    }
    renderInspectorAndCanvas();
}

async function duplicateSelectedBoxOnCanvas() {
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (isSavingCanvas || lastSaveFailed || reviewUpdatePending || !item || !Array.isArray(item.boxes)) return;
    if (selectedBoxIndex < 0 || selectedBoxIndex >= item.boxes.length) {
        showToast('請先點選要複製的標記框', 'info');
        return;
    }
    const snap = snapshotItemForUndo(item);
    const src = item.boxes[selectedBoxIndex];
    const stepX = (src.xc + src.w / 2 + 0.025 <= 1) ? 0.025 : -0.025;
    const stepY = (src.yc + src.h / 2 + 0.025 <= 1) ? 0.025 : -0.025;
    const nx = Math.max(src.w / 2, Math.min(1 - src.w / 2, src.xc + stepX));
    const ny = Math.max(src.h / 2, Math.min(1 - src.h / 2, src.yc + stepY));
    const newBox = {
        class_id: src.class_id,
        class_name: src.class_name,
        xc: nx,
        yc: ny,
        x_center: nx,
        y_center: ny,
        w: src.w,
        h: src.h,
        width: src.w,
        height: src.h
    };
    item.boxes.push(newBox);
    selectedBoxIndex = item.boxes.length - 1;
    isDrawBoxMode = false;
    markCanvasDraftDirty(item, snap);
}

async function changeSelectedBoxClass(boxIdx, newCidVal) {
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (isSavingCanvas || lastSaveFailed || reviewUpdatePending || !item || !Array.isArray(item.boxes)) return;
    if (newCidVal === '__new__') {
        openNewBoxClassModal(boxIdx);
        renderInspectorAndCanvas();
        return;
    }
    const b = item.boxes[boxIdx];
    const newCid = parseInt(newCidVal, 10);
    if (!b || !Number.isFinite(newCid) || Number(b.class_id) === newCid) return;
    const snap = snapshotItemForUndo(item);
    const avail = getAvailableCanvasClasses();
    const found = avail.find(c => c.id === newCid);
    b.class_id = newCid;
    b.class_name = found ? found.name : `class_${newCid}`;
    defaultDrawClassId = newCid;
    markCanvasDraftDirty(item, snap);
}

function reviewRemainingPhotos() {
    const remaining = scanData.items.filter(photo => photo.has_image && photo.review_status !== 'confirmed');
    if (!remaining.length) return;
    presetReviewFilter('pending_review');
    activeStem = remaining[0].stem;
    refreshReviewSelection();
    updateSaveIndicator('saved');
    saveSessionProgress();
}

function isCanvasZoomedOrScrollable(wrapper) {
    if (zoomMultiplier > 1.001) return true;
    if (!wrapper) return false;
    return (wrapper.scrollWidth > wrapper.clientWidth + 2) || (wrapper.scrollHeight > wrapper.clientHeight + 2);
}

function selectBoxFromList(idx) {
    selectedBoxIndex = idx;
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (item && item.boxes && item.boxes[idx]) {
        defaultDrawClassId = Number(item.boxes[idx].class_id);
    }
    renderInspectorAndCanvas();
    const wrapper = document.getElementById('mainCanvasWrapper');
    if (wrapper && canvasRenderState && item?.boxes?.[idx] && isCanvasZoomedOrScrollable(wrapper)) {
        const b = item.boxes[idx];
        const targetX = b.xc * canvasRenderState.drawW - wrapper.clientWidth / 2;
        const targetY = b.yc * canvasRenderState.drawH - wrapper.clientHeight / 2;
        wrapper.scrollLeft = Math.max(0, Math.round(targetX));
        wrapper.scrollTop = Math.max(0, Math.round(targetY));
    }
}

// ============================================================================
// 畫布繪製與直接拖曳微調標記框 (保持照片正確比例，不拉伸變形)
// ============================================================================
function setPreviewMode(mode) {
    mode = mode === 'side_by_side' ? 'side_by_side' : 'single';
    previewMode = mode;
    document.getElementById('targetCanvasRole').textContent = mode === 'side_by_side' ? '右側 · 目前照片' : '目前照片';
    document.querySelectorAll('.cmp-btn').forEach(btn => {
        const active = btn.dataset.vmode === mode;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
    });
    document.getElementById('masterCanvasPane').style.display = mode === 'side_by_side' ? 'flex' : 'none';
    redrawCanvases();
}

function updateOverlayAlpha(val) {
    overlayAlpha = parseInt(val, 10) / 100;
    document.getElementById('overlayAlphaVal').textContent = `${val}%`;
    redrawCanvases();
}

function adjustZoom(factor) {
    const wrapper = document.getElementById('mainCanvasWrapper');
    const prevDrawW = canvasRenderState?.drawW || 0;
    const prevDrawH = canvasRenderState?.drawH || 0;
    let centerRatioX = 0.5;
    let centerRatioY = 0.5;
    if (wrapper && prevDrawW > wrapper.clientWidth && prevDrawW > 0) {
        centerRatioX = (wrapper.scrollLeft + wrapper.clientWidth / 2) / prevDrawW;
    }
    if (wrapper && prevDrawH > wrapper.clientHeight && prevDrawH > 0) {
        centerRatioY = (wrapper.scrollTop + wrapper.clientHeight / 2) / prevDrawH;
    }

    zoomMultiplier = Math.max(0.5, Math.min(4.0, zoomMultiplier * factor));
    document.getElementById('zoomLevelText').textContent = `${Math.round(zoomMultiplier * 100)}%`;
    if (zoomMultiplier > 1.001) {
        selectedBoxIndex = -1;
    }
    redrawCanvases();

    if (wrapper && canvasRenderState) {
        const { drawW, drawH } = canvasRenderState;
        wrapper.scrollLeft = Math.max(0, Math.round(centerRatioX * drawW - wrapper.clientWidth / 2));
        wrapper.scrollTop = Math.max(0, Math.round(centerRatioY * drawH - wrapper.clientHeight / 2));
    }
    const masterWrapper = document.getElementById('masterCanvasWrapper');
    const masterCanvas = document.getElementById('masterCanvas');
    if (masterWrapper && masterCanvas && !masterCanvas.hidden && previewMode === 'side_by_side') {
        masterWrapper.scrollLeft = Math.max(0, Math.round(centerRatioX * masterCanvas.width - masterWrapper.clientWidth / 2));
        masterWrapper.scrollTop = Math.max(0, Math.round(centerRatioY * masterCanvas.height - masterWrapper.clientHeight / 2));
    }
    const tCanvasEl = document.getElementById('targetCanvas');
    if (tCanvasEl && !isDrawBoxMode) {
        tCanvasEl.style.cursor = isCanvasZoomedOrScrollable(wrapper) ? 'grab' : 'default';
    }
}

function toggleMagnifierLoupe(forceState) {
    if (typeof forceState === 'boolean') {
        isMagnifierLoupeEnabled = forceState;
    } else {
        isMagnifierLoupeEnabled = !isMagnifierLoupeEnabled;
    }
    const btn = document.getElementById('btnToggleLoupe');
    if (btn) {
        btn.classList.toggle('active', isMagnifierLoupeEnabled);
        btn.setAttribute('aria-pressed', String(isMagnifierLoupeEnabled));
    }
    redrawCanvases();
}

function drawMagnifierLoupeOnCanvas(ctx, drawW, drawH, item) {
    if (!isMagnifierLoupeEnabled || !canvasHoverPos || !targetImgObj || !canvasRenderState) return;
    const isActivelyAligning = Boolean(
        isDrawBoxMode ||
        (dragAction && (dragAction.mode === 'create' || dragAction.mode === 'resize'))
    );
    if (!isActivelyAligning) return;

    const { imgW, imgH } = canvasRenderState;
    const cx = Math.max(0, Math.min(drawW, canvasHoverPos.x));
    const cy = Math.max(0, Math.min(drawH, canvasHoverPos.y));
    const normX = cx / Math.max(1, drawW);
    const normY = cy / Math.max(1, drawH);
    const srcCenterX = normX * imgW;
    const srcCenterY = normY * imgH;

    const loupeSize = 132;
    const mag = 4.0;
    const halfLoupe = loupeSize / 2;

    // 智慧避讓位置：預設顯示於游標右上方，靠近邊界時自動翻轉至對側，絕不遮擋十字準星
    let lx = cx + 24;
    let ly = cy - loupeSize - 24;
    if (lx + loupeSize + 8 > drawW) {
        lx = Math.max(8, cx - loupeSize - 24);
    }
    if (ly < 8) {
        ly = Math.min(Math.max(8, drawH - loupeSize - 28), cy + 24);
    }

    const srcSpanW = (loupeSize / mag) * (imgW / Math.max(1, drawW));
    const srcSpanH = (loupeSize / mag) * (imgH / Math.max(1, drawH));
    const sx = srcCenterX - srcSpanW / 2;
    const sy = srcCenterY - srcSpanH / 2;

    ctx.save();
    // 外框陰影與底色
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(lx, ly, loupeSize, loupeSize + 22);
    ctx.shadowBlur = 0;

    // 裁切放大鏡視窗並關閉平滑以呈現清晰像素邊緣
    ctx.save();
    ctx.beginPath();
    ctx.rect(lx, ly, loupeSize, loupeSize);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(targetImgObj, sx, sy, srcSpanW, srcSpanH, lx, ly, loupeSize, loupeSize);

    // 同步繪製目前正在拉動或縮放的標記框邊緣線於放大鏡內
    ctx.strokeStyle = '#F08A4C';
    ctx.lineWidth = 1.5;
    if (dragAction && dragAction.mode === 'create') {
        const rx = Math.min(dragAction.startX, dragAction.curX);
        const ry = Math.min(dragAction.startY, dragAction.curY);
        const rw = Math.abs(dragAction.curX - dragAction.startX);
        const rh = Math.abs(dragAction.curY - dragAction.startY);
        ctx.strokeRect(
            lx + halfLoupe + (rx - cx) * mag,
            ly + halfLoupe + (ry - cy) * mag,
            rw * mag,
            rh * mag
        );
    } else if (selectedBoxIndex >= 0 && item?.boxes?.[selectedBoxIndex]) {
        const sb = item.boxes[selectedBoxIndex];
        const sbw = sb.w * drawW, sbh = sb.h * drawH;
        const sbx = sb.xc * drawW - sbw / 2, sby = sb.yc * drawH - sbh / 2;
        ctx.strokeRect(
            lx + halfLoupe + (sbx - cx) * mag,
            ly + halfLoupe + (sby - cy) * mag,
            sbw * mag,
            sbh * mag
        );
    }

    // 中心精準十字準星 (Crosshair)
    const midX = lx + halfLoupe;
    const midY = ly + halfLoupe;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, midY); ctx.lineTo(midX - 4, midY);
    ctx.moveTo(midX + 4, midY); ctx.lineTo(lx + loupeSize, midY);
    ctx.moveTo(midX, ly); ctx.lineTo(midX, midY - 4);
    ctx.moveTo(midX, midY + 4); ctx.lineTo(midX, ly + loupeSize);
    ctx.stroke();

    ctx.strokeStyle = '#F08A4C';
    ctx.strokeRect(midX - 3, midY - 3, 6, 6);
    ctx.restore();

    // 放大鏡邊框與底部像素座標列
    ctx.strokeStyle = '#F08A4C';
    ctx.lineWidth = 2;
    ctx.strokeRect(lx, ly, loupeSize, loupeSize + 22);
    ctx.fillStyle = '#1E293B';
    ctx.fillRect(lx + 1, ly + loupeSize, loupeSize - 2, 21);
    ctx.fillStyle = '#F8FAFC';
    ctx.font = 'bold 11px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`4× | X:${Math.round(srcCenterX)} Y:${Math.round(srcCenterY)}`, lx + halfLoupe, ly + loupeSize + 15);
    ctx.restore();
}

function resetZoom() {
    zoomMultiplier = 1.0;
    document.getElementById('zoomLevelText').textContent = '適應視窗';
    redrawCanvases();
    const wrapper = document.getElementById('mainCanvasWrapper');
    if (wrapper) {
        wrapper.scrollLeft = 0;
        wrapper.scrollTop = 0;
    }
    const masterWrapper = document.getElementById('masterCanvasWrapper');
    if (masterWrapper) {
        masterWrapper.scrollLeft = 0;
        masterWrapper.scrollTop = 0;
    }
    const tCanvasEl = document.getElementById('targetCanvas');
    if (tCanvasEl && !isDrawBoxMode) {
        tCanvasEl.style.cursor = 'default';
    }
}

let comparisonChoiceStem = null;
let comparisonChoiceWorkspace = null;
function getComparisonReference(item) {
    return scanData.items.find(photo => photo.has_image && photo.is_valid_reference && photo.stem === masterStem) || null;
}

function renderComparisonPicker() {}

let comparisonReference = null;
let comparisonLoadFailed = false;
let canvasImageRequest = 0;
let loadedTargetImgKey = '';
let loadedMasterImgKey = '';
function loadImagesAndDrawCanvas(item) {
    comparisonReference = item?.has_image ? getComparisonReference(item) : null;
    renderComparisonPicker(item);
    if (!item || !item.has_image) {
        canvasImageRequest++;
        targetImgObj = null;
        masterImgObj = null;
        loadedTargetImgKey = '';
        loadedMasterImgKey = '';
        comparisonLoadFailed = false;
        redrawCanvases();
        return;
    }

    const wsId = scanData?.workspace_id || '';
    const nextTargetKey = `${wsId}::${item.stem}`;
    const nextMasterKey = comparisonReference ? `${wsId}::${comparisonReference.stem}` : '';

    if (targetImgObj && loadedTargetImgKey === nextTargetKey) {
        if (!comparisonReference) {
            masterImgObj = null;
            loadedMasterImgKey = '';
            comparisonLoadFailed = false;
            redrawCanvases();
            return;
        }
        if (masterImgObj && loadedMasterImgKey === nextMasterKey) {
            redrawCanvases();
            return;
        }
    }

    const requestId = ++canvasImageRequest;
    if (loadedTargetImgKey !== nextTargetKey) {
        targetImgObj = null;
        loadedTargetImgKey = '';
    }
    if (loadedMasterImgKey !== nextMasterKey) {
        masterImgObj = null;
        loadedMasterImgKey = '';
        comparisonLoadFailed = false;
    }
    redrawCanvases();

    const loadMasterIfNeeded = () => {
        if (!comparisonReference) return;
        if (masterImgObj && loadedMasterImgKey === nextMasterKey) {
            redrawCanvases();
            return;
        }
        const mImg = new Image();
        mImg.onload = () => {
            if (requestId !== canvasImageRequest) return;
            masterImgObj = mImg;
            loadedMasterImgKey = nextMasterKey;
            redrawCanvases();
        };
        mImg.onerror = () => {
            if (requestId !== canvasImageRequest) return;
            comparisonLoadFailed = true;
            redrawCanvases();
        };
        mImg.src = workspaceImage(comparisonReference.stem);
    };

    if (targetImgObj && loadedTargetImgKey === nextTargetKey) {
        loadMasterIfNeeded();
        return;
    }

    const tImg = new Image();
    tImg.onload = () => {
        if (requestId !== canvasImageRequest) return;
        targetImgObj = tImg;
        loadedTargetImgKey = nextTargetKey;
        redrawCanvases();
        loadMasterIfNeeded();
    };
    tImg.onerror = () => {
        if (requestId !== canvasImageRequest) return;
        targetImgObj = null;
        loadedTargetImgKey = '';
        redrawCanvases();
        showToast("照片載入失敗，請重新掃描資料夾", "error");
    };
    tImg.src = `${workspaceImage(item.stem)}`;
}

function redrawCanvases() {
    const tCanvas = document.getElementById('targetCanvas');
    const wrapper = document.getElementById('mainCanvasWrapper');
    if (!tCanvas || !wrapper) return;
    const ctx = tCanvas.getContext('2d');
    const referenceName = comparisonReference?.image_name || comparisonReference?.stem;
    const referenceStatus = !comparisonReference ? '沒有其他可比較照片'
        : comparisonLoadFailed ? '參考照片載入失敗'
        : masterImgObj ? referenceName : '正在載入參考照片…';
    const masterCaption = document.getElementById('masterCanvasCaption');
    masterCaption.textContent = referenceStatus;
    masterCaption.title = referenceStatus;
    const comparisonStatus = document.getElementById('comparisonStatus');
    comparisonStatus.textContent = previewMode === 'overlay' ? '比較：' + referenceStatus : '';
    comparisonStatus.title = comparisonStatus.textContent;
    const masterCanvas = document.getElementById('masterCanvas');
    masterCanvas.hidden = !masterImgObj;

    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (!item || !targetImgObj) {
        if (tCanvas.width !== 480) tCanvas.width = 480;
        if (tCanvas.height !== 320) tCanvas.height = 320;
        tCanvas.style.width = '480px';
        tCanvas.style.height = '320px';
        ctx.fillStyle = '#12191F';
        ctx.fillRect(0, 0, tCanvas.width, tCanvas.height);
        ctx.fillStyle = '#94A3B8';
        ctx.font = '16px "Microsoft JhengHei", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('無可顯示的照片影像', tCanvas.width / 2, tCanvas.height / 2);
        return;
    }

    // 計算等比例縮放，確保完全適應視窗且絕不變形（使用 offsetWidth/offsetHeight 避免捲軸出現時基準抖動）
    const availW = Math.max(1, (wrapper.offsetWidth || wrapper.clientWidth) - 20);
    const availH = Math.max(1, (wrapper.offsetHeight || wrapper.clientHeight) - 24);
    const imgW = targetImgObj.naturalWidth || item.img_width || 640;
    const imgH = targetImgObj.naturalHeight || item.img_height || 480;

    const baseScale = Math.min(availW / imgW, availH / imgH);
    const finalScale = baseScale * zoomMultiplier;

    const drawW = Math.max(1, Math.round(imgW * finalScale));
    const drawH = Math.max(1, Math.round(imgH * finalScale));

    if (tCanvas.width !== drawW) tCanvas.width = drawW;
    if (tCanvas.height !== drawH) tCanvas.height = drawH;
    tCanvas.style.width = `${drawW}px`;
    tCanvas.style.height = `${drawH}px`;
    canvasRenderState = { drawW, drawH, imgW, imgH, scale: finalScale };

    ctx.clearRect(0, 0, drawW, drawH);
    ctx.drawImage(targetImgObj, 0, 0, drawW, drawH);

    // 若為半透明疊圖模式，疊加參考照片
    if (previewMode === 'overlay' && masterImgObj) {
        ctx.save();
        ctx.globalAlpha = overlayAlpha;
        ctx.drawImage(masterImgObj, 0, 0, drawW, drawH);
        ctx.restore();
    }

    // 繪製標記框
    const showBoxes = true;
    if (showBoxes && item.boxes && item.boxes.length > 0) {
        drawBoxesOnContext(ctx, item.boxes, drawW, drawH, selectedBoxIndex);
    }

    // 新增標記框模式的十字輔助線與即時拉框預覽
    if (pendingNewBox) {
        const bw = pendingNewBox.w * drawW;
        const bh = pendingNewBox.h * drawH;
        const bx = pendingNewBox.xc * drawW - bw / 2;
        const by = pendingNewBox.yc * drawH - bh / 2;
        ctx.save();
        ctx.strokeStyle = '#F08A4C';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(bx, by, bw, bh);
        ctx.fillStyle = 'rgba(240, 138, 76, 0.24)';
        ctx.fillRect(bx, by, bw, bh);
        ctx.restore();
    } else if (isDrawBoxMode) {
        if (dragAction && dragAction.mode === 'create') {
            const rx = Math.min(dragAction.startX, dragAction.curX);
            const ry = Math.min(dragAction.startY, dragAction.curY);
            const rw = Math.abs(dragAction.curX - dragAction.startX);
            const rh = Math.abs(dragAction.curY - dragAction.startY);
            ctx.save();
            ctx.strokeStyle = '#F08A4C';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([6, 4]);
            ctx.strokeRect(rx, ry, rw, rh);
            ctx.fillStyle = 'rgba(240, 138, 76, 0.22)';
            ctx.fillRect(rx, ry, rw, rh);
            ctx.restore();
        } else if (canvasHoverPos) {
            ctx.save();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(canvasHoverPos.x, 0);
            ctx.lineTo(canvasHoverPos.x, drawH);
            ctx.moveTo(0, canvasHoverPos.y);
            ctx.lineTo(drawW, canvasHoverPos.y);
            ctx.stroke();
            ctx.restore();
        }
    }

    // 貼齊邊緣放大鏡 (Magnifier Loupe)：於拉框或調整 8 點控制點時顯示局部 4 倍像素放大與準星
    drawMagnifierLoupeOnCanvas(ctx, drawW, drawH, item);

    // 並排比較模式：繪製左側參考照片畫布
    if (previewMode === 'side_by_side') {
        const mCanvas = masterCanvas;
        const mItem = comparisonReference;
        if (masterImgObj && mItem) {
            const referenceWrapper = document.getElementById('masterCanvasWrapper');
            const width = masterImgObj.naturalWidth;
            const height = masterImgObj.naturalHeight;
            const scale = Math.min(
                Math.max(1, (referenceWrapper.offsetWidth || referenceWrapper.clientWidth) - 20) / width,
                Math.max(1, (referenceWrapper.offsetHeight || referenceWrapper.clientHeight) - 20) / height
            ) * zoomMultiplier;
            const mDrawW = Math.max(1, Math.round(width * scale));
            const mDrawH = Math.max(1, Math.round(height * scale));
            if (mCanvas.width !== mDrawW) mCanvas.width = mDrawW;
            if (mCanvas.height !== mDrawH) mCanvas.height = mDrawH;
            mCanvas.style.width = `${mDrawW}px`;
            mCanvas.style.height = `${mDrawH}px`;
            const mCtx = mCanvas.getContext('2d');
            mCtx.clearRect(0, 0, mDrawW, mDrawH);
            mCtx.drawImage(masterImgObj, 0, 0, mDrawW, mDrawH);
            if (showBoxes && mItem.boxes) {
                drawBoxesOnContext(mCtx, mItem.boxes, mDrawW, mDrawH, -1);
            }
        }
    }
}

function getBoxResizeHandles(bx, by, bw, bh) {
    const handles = [
        { name: 'tl', x: bx, y: by, cursor: 'nwse-resize' },
        { name: 'tr', x: bx + bw, y: by, cursor: 'nesw-resize' },
        { name: 'bl', x: bx, y: by + bh, cursor: 'nesw-resize' },
        { name: 'br', x: bx + bw, y: by + bh, cursor: 'nwse-resize' }
    ];
    if (bw >= 24) {
        handles.push(
            { name: 'tc', x: bx + bw / 2, y: by, cursor: 'ns-resize' },
            { name: 'bc', x: bx + bw / 2, y: by + bh, cursor: 'ns-resize' }
        );
    }
    if (bh >= 24) {
        handles.push(
            { name: 'ml', x: bx, y: by + bh / 2, cursor: 'ew-resize' },
            { name: 'mr', x: bx + bw, y: by + bh / 2, cursor: 'ew-resize' }
        );
    }
    return handles;
}

function drawBoxesOnContext(ctx, boxes, W, H, highlightIdx) {
    boxes.forEach((b, idx) => {
        const bw = b.w * W;
        const bh = b.h * H;
        const bx = (b.xc * W) - (bw / 2);
        const by = (b.yc * H) - (bh / 2);
        const isSel = idx === highlightIdx;
        const color = isSel ? '#F08A4C' : CLASS_COLORS[b.class_id % CLASS_COLORS.length];

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.strokeRect(bx, by, bw, bh);

        ctx.fillStyle = color;
        ctx.globalAlpha = isSel ? 0.24 : 0.12;
        ctx.fillRect(bx, by, bw, bh);
        ctx.restore();

        // 標籤文字背景
        const labelStr = `#${idx + 1} ${b.class_name}`;
        ctx.font = 'bold 17px "Microsoft JhengHei", sans-serif';
        const textW = ctx.measureText(labelStr).width + 10;
        const labelHeight = 25;
        const labelY = Math.max(labelHeight, by);
        ctx.fillStyle = color;
        const labelX = Math.max(0, Math.min(bx, W - textW));
        ctx.fillRect(labelX, labelY - labelHeight, textW, labelHeight);
        ctx.fillStyle = isSel ? '#17232A' : '#FFFFFF';
        ctx.fillText(labelStr, labelX + 5, labelY - 5, Math.max(1, W - 10));

        // 選取框的 8 點縮放控制點（四角 + 上下左右四邊中點）
        if (isSel) {
            const handles = getBoxResizeHandles(bx, by, bw, bh);
            ctx.fillStyle = '#FFFFFF';
            ctx.strokeStyle = '#17232A';
            ctx.lineWidth = 1.5;
            handles.forEach(({ x: hx, y: hy }) => {
                ctx.fillRect(hx - 4, hy - 4, 8, 8);
                ctx.strokeRect(hx - 4, hy - 4, 8, 8);
            });
        }
    });
}

function initCanvasInteraction() {
    const canvas = document.getElementById('targetCanvas');
    const mainWrapper = document.getElementById('mainCanvasWrapper');
    const masterCanvas = document.getElementById('masterCanvas');
    const masterWrapper = document.getElementById('masterCanvasWrapper');
    if (!canvas) return;

    // 支援 Ctrl + 滑鼠滾輪直接縮放畫布
    const handleWheelZoom = (e) => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            adjustZoom(e.deltaY < 0 ? 1.15 : 0.87);
        }
    };
    if (mainWrapper) mainWrapper.addEventListener('wheel', handleWheelZoom, { passive: false });
    if (masterWrapper) masterWrapper.addEventListener('wheel', handleWheelZoom, { passive: false });

    // 左側並排參考照片畫布：放大時支援滑鼠拖移檢視
    if (masterWrapper) {
        masterWrapper.addEventListener('mousedown', (e) => {
            if (e.button !== 0 && e.button !== 1) return;
            if (!isCanvasZoomedOrScrollable(masterWrapper)) return;
            e.preventDefault();
            dragAction = {
                mode: 'pan',
                wrapper: masterWrapper,
                canvasEl: masterCanvas,
                startClientX: e.clientX,
                startClientY: e.clientY,
                startScrollLeft: masterWrapper.scrollLeft,
                startScrollTop: masterWrapper.scrollTop,
                hitBoxIdx: -1,
                modified: false
            };
            if (masterCanvas) masterCanvas.style.cursor = 'grabbing';
        });
    }

    // 若使用者在主畫布外圍暗色留白區按住拖曳，且處於放大狀態，亦支援平移照片
    if (mainWrapper) {
        mainWrapper.addEventListener('mousedown', (e) => {
            if (e.target === canvas) return;
            if ((e.button !== 0 && e.button !== 1) || isDrawBoxMode) return;
            if (!isCanvasZoomedOrScrollable(mainWrapper)) return;
            dragAction = {
                mode: 'pan',
                wrapper: mainWrapper,
                canvasEl: canvas,
                startClientX: e.clientX,
                startClientY: e.clientY,
                startScrollLeft: mainWrapper.scrollLeft,
                startScrollTop: mainWrapper.scrollTop,
                hitBoxIdx: -1,
                modified: false
            };
            canvas.style.cursor = 'grabbing';
        });
    }

    canvas.addEventListener('mousedown', (e) => {
        if ((e.button !== 0 && e.button !== 1) || !scanData || !canvasRenderState || isSavingCanvas || lastSaveFailed || reviewUpdatePending) return;
        const item = scanData.items.find(i => i.stem === activeStem);
        if (!item || !item.has_image) return;
        if (!Array.isArray(item.boxes)) item.boxes = [];

        const wrapper = document.getElementById('mainCanvasWrapper');
        const isZoomed = isCanvasZoomedOrScrollable(wrapper);

        const rect = canvas.getBoundingClientRect();
        const mx = Math.max(0, Math.min(canvasRenderState.drawW, (e.clientX - rect.left) * canvas.width / rect.width));
        const my = Math.max(0, Math.min(canvasRenderState.drawH, (e.clientY - rect.top) * canvas.height / rect.height));
        const { drawW, drawH } = canvasRenderState;

        // 滑鼠中鍵：在放大狀態下一律拖移照片
        if (e.button === 1) {
            if (isZoomed && wrapper) {
                e.preventDefault();
                dragAction = {
                    mode: 'pan',
                    wrapper,
                    canvasEl: canvas,
                    startClientX: e.clientX,
                    startClientY: e.clientY,
                    startScrollLeft: wrapper.scrollLeft,
                    startScrollTop: wrapper.scrollTop,
                    hitBoxIdx: -1,
                    modified: false
                };
                canvas.style.cursor = 'grabbing';
            }
            return;
        }

        // 0. 若處於「新增標記框」模式，開始拉出新框
        if (isDrawBoxMode) {
            dragAction = {
                mode: 'create',
                startX: mx,
                startY: my,
                curX: mx,
                curY: my,
                modified: false
            };
            redrawCanvases();
            return;
        }

        // 1. 先檢查是否點到目前選取框的 8 個縮放控制點（四角 + 四邊中點）與選取框內部
        if (selectedBoxIndex >= 0 && selectedBoxIndex < item.boxes.length) {
            const b = item.boxes[selectedBoxIndex];
            const bw = b.w * drawW, bh = b.h * drawH;
            const bx = b.xc * drawW - bw / 2, by = b.yc * drawH - bh / 2;
            const handles = getBoxResizeHandles(bx, by, bw, bh);
            for (const c of handles) {
                if (Math.abs(mx - c.x) <= 8 && Math.abs(my - c.y) <= 8) {
                    dragAction = {
                        mode: 'resize',
                        corner: c.name,
                        boxIdx: selectedBoxIndex,
                        origBox: { ...b },
                        preDragSnap: snapshotItemForUndo(item),
                        modified: false
                    };
                    return;
                }
            }
            // 若點在「目前已選取」的標記框內部，允許拖曳移動該標記框
            if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
                dragAction = {
                    mode: 'move',
                    boxIdx: selectedBoxIndex,
                    startX: mx,
                    startY: my,
                    origBox: { ...b },
                    preDragSnap: snapshotItemForUndo(item),
                    wasAlreadySelected: true,
                    modified: false
                };
                return;
            }
        }

        // 2. 檢查是否點到任一標記框內部
        let hitBoxIdx = -1;
        for (let i = item.boxes.length - 1; i >= 0; i--) {
            const b = item.boxes[i];
            const bw = b.w * drawW, bh = b.h * drawH;
            const bx = b.xc * drawW - bw / 2, by = b.yc * drawH - bh / 2;
            if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
                hitBoxIdx = i;
                break;
            }
        }

        // 3. 若照片處於放大（或出現捲軸）狀態：
        //    按住滑鼠拖移時一律平移檢視照片 (pan)；若僅單擊未拖移則選取／取消選取標記框
        if (isZoomed && wrapper) {
            e.preventDefault();
            dragAction = {
                mode: 'pan',
                wrapper,
                canvasEl: canvas,
                startClientX: e.clientX,
                startClientY: e.clientY,
                startScrollLeft: wrapper.scrollLeft,
                startScrollTop: wrapper.scrollTop,
                hitBoxIdx,
                modified: false
            };
            canvas.style.cursor = 'grabbing';
            return;
        }

        // 4. 一般適應視窗狀態（未放大）：點中標記框可直接選取並拖曳微調位置
        if (hitBoxIdx >= 0) {
            const b = item.boxes[hitBoxIdx];
            const preSnap = snapshotItemForUndo(item);
            selectedBoxIndex = hitBoxIdx;
            defaultDrawClassId = Number(b.class_id);
            dragAction = {
                mode: 'move',
                boxIdx: hitBoxIdx,
                startX: mx,
                startY: my,
                origBox: { ...b },
                preDragSnap: preSnap,
                wasAlreadySelected: false,
                modified: false
            };
            renderInspectorAndCanvas();
            return;
        }

        selectedBoxIndex = -1;
        renderInspectorAndCanvas();
    });

    canvas.addEventListener('mouseleave', () => {
        if (isDrawBoxMode && !dragAction) {
            canvasHoverPos = null;
            redrawCanvases();
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (dragAction && dragAction.mode === 'pan') {
            const dxClient = e.clientX - dragAction.startClientX;
            const dyClient = e.clientY - dragAction.startClientY;
            if (Math.hypot(dxClient, dyClient) >= 4) {
                dragAction.modified = true;
            }
            if (dragAction.wrapper) {
                dragAction.wrapper.scrollLeft = Math.max(0, dragAction.startScrollLeft - dxClient);
                dragAction.wrapper.scrollTop = Math.max(0, dragAction.startScrollTop - dyClient);
                // 若為並排比較模式且拖曳主畫布，同步捲動左側參考照片畫布方便對照
                if (previewMode === 'side_by_side' && dragAction.wrapper === mainWrapper && masterWrapper) {
                    const maxMainX = Math.max(1, mainWrapper.scrollWidth - mainWrapper.clientWidth);
                    const maxMainY = Math.max(1, mainWrapper.scrollHeight - mainWrapper.clientHeight);
                    const maxMasterX = Math.max(0, masterWrapper.scrollWidth - masterWrapper.clientWidth);
                    const maxMasterY = Math.max(0, masterWrapper.scrollHeight - masterWrapper.clientHeight);
                    masterWrapper.scrollLeft = Math.round((mainWrapper.scrollLeft / maxMainX) * maxMasterX);
                    masterWrapper.scrollTop = Math.round((mainWrapper.scrollTop / maxMainY) * maxMasterY);
                }
            }
            return;
        }

        if (!canvasRenderState) return;
        const canvas = document.getElementById('targetCanvas');
        const item = scanData?.items?.find(i => i.stem === activeStem);
        if (!canvas || !item) return;

        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const rawX = (e.clientX - rect.left) * canvas.width / rect.width;
        const rawY = (e.clientY - rect.top) * canvas.height / rect.height;
        const mx = Math.max(0, Math.min(canvasRenderState.drawW, rawX));
        const my = Math.max(0, Math.min(canvasRenderState.drawH, rawY));
        const { drawW, drawH } = canvasRenderState;

        if (!dragAction) {
            if (isDrawBoxMode) {
                canvas.style.cursor = 'crosshair';
                if (rawX >= 0 && rawX <= drawW && rawY >= 0 && rawY <= drawH) {
                    canvasHoverPos = { x: mx, y: my };
                    redrawCanvases();
                }
                return;
            }
            // 動態更新滑鼠游標提示（8 點縮放控制點 / 移動框 / 拖移放大照片）
            let nextCursor = isCanvasZoomedOrScrollable(mainWrapper) ? 'grab' : 'default';
            if (selectedBoxIndex >= 0 && item.boxes && item.boxes[selectedBoxIndex]) {
                const sb = item.boxes[selectedBoxIndex];
                const sbw = sb.w * drawW, sbh = sb.h * drawH;
                const sbx = sb.xc * drawW - sbw / 2, sby = sb.yc * drawH - sbh / 2;
                const handles = getBoxResizeHandles(sbx, sby, sbw, sbh);
                const hitHandle = handles.find(c => Math.abs(mx - c.x) <= 8 && Math.abs(my - c.y) <= 8);
                if (hitHandle) {
                    nextCursor = hitHandle.cursor;
                } else if (mx >= sbx && mx <= sbx + sbw && my >= sby && my <= sby + sbh) {
                    nextCursor = 'move';
                }
            } else if (!isCanvasZoomedOrScrollable(mainWrapper) && Array.isArray(item.boxes)) {
                for (let i = item.boxes.length - 1; i >= 0; i--) {
                    const b = item.boxes[i];
                    const bw = b.w * drawW, bh = b.h * drawH;
                    const bx = b.xc * drawW - bw / 2, by = b.yc * drawH - bh / 2;
                    if (mx >= bx && mx <= bx + bw && my >= by && my <= by + bh) {
                        nextCursor = 'move';
                        break;
                    }
                }
            }
            if (canvas.style.cursor !== nextCursor) {
                canvas.style.cursor = nextCursor;
            }
            return;
        }

        if (dragAction.mode === 'create') {
            dragAction.curX = mx;
            dragAction.curY = my;
            dragAction.modified = (Math.abs(mx - dragAction.startX) >= 4 && Math.abs(my - dragAction.startY) >= 4);
            canvasHoverPos = { x: mx, y: my };
            redrawCanvases();
            return;
        }

        const b = item.boxes[dragAction.boxIdx];
        if (!b) return;

        if (dragAction.mode === 'move') {
            const dx = (mx - dragAction.startX) / drawW;
            const dy = (my - dragAction.startY) / drawH;
            if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
                dragAction.modified = true;
                b.xc = Math.max(b.w / 2, Math.min(1 - b.w / 2, dragAction.origBox.xc + dx));
                b.yc = Math.max(b.h / 2, Math.min(1 - b.h / 2, dragAction.origBox.yc + dy));
                redrawCanvases();
            }
        } else if (dragAction.mode === 'resize') {
            dragAction.modified = true;
            canvasHoverPos = { x: mx, y: my };
            const ob = dragAction.origBox;
            let x1 = ob.xc - ob.w / 2;
            let y1 = ob.yc - ob.h / 2;
            let x2 = ob.xc + ob.w / 2;
            let y2 = ob.yc + ob.h / 2;
            const nx = mx / drawW;
            const ny = my / drawH;

            if (dragAction.corner.includes('l')) x1 = Math.min(x2 - 0.01, nx);
            if (dragAction.corner.includes('r')) x2 = Math.max(x1 + 0.01, nx);
            if (dragAction.corner.includes('t')) y1 = Math.min(y2 - 0.01, ny);
            if (dragAction.corner.includes('b')) y2 = Math.max(y1 + 0.01, ny);

            b.w = Math.max(0.01, x2 - x1);
            b.h = Math.max(0.01, y2 - y1);
            b.xc = (x1 + x2) / 2;
            b.yc = (y1 + y2) / 2;
            redrawCanvases();
        }
    });

    window.addEventListener('mouseup', () => {
        if (!dragAction) return;
        const item = scanData?.items?.find(i => i.stem === activeStem);

        if (dragAction.mode === 'pan') {
            const panState = dragAction;
            dragAction = null;
            if (panState.canvasEl) {
                panState.canvasEl.style.cursor = isCanvasZoomedOrScrollable(panState.wrapper) ? 'grab' : 'default';
            }
            // 若在主畫布僅單擊（未拖移超過 4px），則切換選取／取消選取標記框
            if (!panState.modified && panState.wrapper === mainWrapper && item) {
                if (panState.hitBoxIdx >= 0 && Array.isArray(item.boxes) && item.boxes[panState.hitBoxIdx]) {
                    selectedBoxIndex = panState.hitBoxIdx;
                    defaultDrawClassId = Number(item.boxes[selectedBoxIndex].class_id);
                } else {
                    selectedBoxIndex = -1;
                }
                renderInspectorAndCanvas();
            }
            return;
        }

        if (dragAction.mode === 'create') {
            const { drawW, drawH } = canvasRenderState || { drawW: 1, drawH: 1 };
            const x1 = Math.max(0, Math.min(dragAction.startX, dragAction.curX) / drawW);
            const y1 = Math.max(0, Math.min(dragAction.startY, dragAction.curY) / drawH);
            const x2 = Math.min(1, Math.max(dragAction.startX, dragAction.curX) / drawW);
            const y2 = Math.min(1, Math.max(dragAction.startY, dragAction.curY) / drawH);
            const w = x2 - x1;
            const h = y2 - y1;
            dragAction = null;

            if (item && w >= 0.01 && h >= 0.01) {
                pendingNewBox = {
                    xc: (x1 + x2) / 2,
                    yc: (y1 + y2) / 2,
                    w,
                    h
                };
                isDrawBoxMode = false;
                canvasHoverPos = null;
                redrawCanvases();
                openNewBoxClassModal(-1);
            } else {
                redrawCanvases();
            }
            return;
        }

        const doneDrag = dragAction;
        if (!isDrawBoxMode) canvasHoverPos = null;
        dragAction = null;

        if (doneDrag.modified && item) {
            markCanvasDraftDirty(item, doneDrag.preDragSnap);
        } else if (doneDrag.mode === 'move' && doneDrag.wasAlreadySelected && isCanvasZoomedOrScrollable(mainWrapper)) {
            // 在放大狀態下若單擊已選取的標記框且未拖動，可取消選取以便隨時拖移照片
            selectedBoxIndex = -1;
            renderInspectorAndCanvas();
        }
    });
}

function snapshotItemForUndo(item) {
    if (!item) return null;
    return {
        stem: item.stem,
        boxes: JSON.parse(JSON.stringify(item.boxes || [])),
        box_count: item.box_count,
        review_state: item.review_state,
        review_status: item.review_status,
        review_label: item.review_label,
        is_valid_reference: item.is_valid_reference,
        has_blocking_error: item.has_blocking_error,
        format_status: item.format_status,
        format_label: item.format_label,
        is_empty_file: item.is_empty_file,
        issues: JSON.parse(JSON.stringify(item.issues || [])),
        status: item.status
    };
}

function restoreItemFromUndoSnapshot(item, snap) {
    if (!item || !snap) return;
    item.boxes = JSON.parse(JSON.stringify(snap.boxes || []));
    item.box_count = snap.box_count ?? item.boxes.length;
    item.review_state = snap.review_state;
    item.review_status = snap.review_status;
    item.review_label = snap.review_label;
    item.is_valid_reference = snap.is_valid_reference;
    item.has_blocking_error = snap.has_blocking_error;
    item.format_status = snap.format_status;
    item.format_label = snap.format_label;
    item.is_empty_file = snap.is_empty_file;
    item.issues = JSON.parse(JSON.stringify(snap.issues || []));
    item.status = snap.status;
}

function syncItemLocalDraftState(item) {
    if (!item) return;
    if (!Array.isArray(item.boxes)) item.boxes = [];
    const classesArr = Array.isArray(scanData?.classes) ? scanData.classes : [];
    const hasClasses = classesArr.length > 0;

    const imgIssues = (item.issues || []).filter(i => i.code === 'EXIF_ROTATION' || i.code === 'IMAGE_CORRUPT');
    const localIssues = [...imgIssues];
    let hasBlocking = imgIssues.some(i => i.blocking);

    for (const b of item.boxes) {
        const xc = Number(b.xc ?? b.x_center);
        const yc = Number(b.yc ?? b.y_center);
        const w = Number(b.w ?? b.width);
        const h = Number(b.h ?? b.height);
        b.xc = xc; b.yc = yc; b.w = w; b.h = h;
        b.x_center = xc; b.y_center = yc; b.width = w; b.height = h;
        const cid = parseInt(b.class_id, 10);
        if (hasClasses && cid >= 0 && cid < classesArr.length && classesArr[cid]) {
            b.class_name = classesArr[cid];
        } else if (!b.class_name) {
            b.class_name = `未定義類別(${cid})`;
        }

        if (![xc, yc, w, h].every(Number.isFinite) || !(xc >= 0 && xc <= 1 && yc >= 0 && yc <= 1 && w > 0 && w <= 1 && h > 0 && h <= 1)) {
            hasBlocking = true;
            localIssues.push({
                level: 'error',
                code: 'COORD_ABNORMAL',
                blocking: true,
                reason: '標記框座標超出正常範圍 [0, 1]',
                suggestion: '請於畫布重新調整或刪除異常標記框。',
                message: '標記框座標超出正常範圍 [0, 1]'
            });
        }
        if (hasClasses && (!Number.isInteger(cid) || cid < 0 || cid >= classesArr.length)) {
            hasBlocking = true;
            localIssues.push({
                level: 'error',
                code: 'CLASS_OUT_OF_RANGE',
                blocking: true,
                reason: `類別編號 ${cid} 超出目前類別清單範圍`,
                suggestion: '請重新選擇有效類別或執行類別修正。',
                message: `類別編號 ${cid} 超出目前類別清單範圍`
            });
        }
    }

    item.box_count = item.boxes.length;
    item.is_empty_file = item.boxes.length === 0;
    item.issues = localIssues;
    item.has_blocking_error = hasBlocking;
    item.format_status = hasBlocking ? 'format_error' : (item.boxes.length > 0 ? 'valid' : (item.has_label ? 'empty_file' : 'missing_label'));
    item.format_label = hasBlocking ? '格式異常' : (item.boxes.length > 0 ? '格式檢查正常' : (item.has_label ? '空白標記檔' : '未建立標記檔'));
    item.review_state = '';
    item.review_status = hasBlocking ? 'needs_fix' : ((item.boxes.length > 0 || item.has_label) ? 'pending_review' : 'unlabeled');
    item.review_label = hasBlocking ? '需修正' : (item.review_status === 'pending_review' ? '待人工確認' : '未標記');
    item.is_valid_reference = item.boxes.length > 0 && !hasBlocking;
    item.status = hasBlocking ? 'error' : (localIssues.length > 0 ? 'warning' : 'pass');
}

function markCanvasDraftDirty(item, preSnap) {
    if (!item) return;
    if (dirtyCanvasStem !== item.stem) {
        dirtyCanvasStem = item.stem;
        dirtyCanvasOrigState = preSnap || snapshotItemForUndo(item);
        localCanvasUndoStack = preSnap ? [preSnap] : [];
    } else if (preSnap) {
        localCanvasUndoStack.push(preSnap);
        if (localCanvasUndoStack.length > 50) localCanvasUndoStack.shift();
    }

    lastSaveFailed = false;
    pendingSavePayload = null;
    syncItemLocalDraftState(item);
    recomputeClientSummaryCounts();
    updateHeaderAndNavBadges();
    renderLoadStepSummary();
    renderStudioFileList();
    renderInspectorAndCanvas();
}

async function flushUnsavedCanvasDraftIfNeeded() {
    if (!dirtyCanvasStem || !scanData || !scanData.ok) return true;
    if (isSavingCanvas && activeSavePromise) {
        const pendingOk = await activeSavePromise;
        if (!pendingOk) return false;
        if (!dirtyCanvasStem) return true;
    }
    const item = scanData.items?.find(i => i.stem === dirtyCanvasStem);
    if (!item) {
        dirtyCanvasStem = null;
        dirtyCanvasOrigState = null;
        localCanvasUndoStack = [];
        return true;
    }
    return await saveCanvasBoxesToDisk(item.stem, item.boxes, { confirm: false, skipInspectorRender: true });
}

function applySingleSavePatch(data) {
    if (!scanData || !data || !data.item_patch) return;
    const patch = data.item_patch;
    const item = scanData.items?.find(i => i.stem === patch.stem);
    if (!item) return;

    const imgIssues = (item.issues || []).filter(i => i.code === 'EXIF_ROTATION' || i.code === 'IMAGE_CORRUPT');
    const mergedIssues = [...imgIssues, ...(patch.issues || [])];
    const hasBlocking = Boolean(patch.has_blocking_error) || mergedIssues.some(i => i.blocking);

    Object.assign(item, patch);
    item.issues = mergedIssues;
    item.has_blocking_error = hasBlocking;
    item.is_valid_reference = item.boxes.length > 0 && !hasBlocking;
    if (hasBlocking && item.review_status !== 'needs_fix') {
        item.review_status = 'needs_fix';
        item.review_label = '需修正';
    }

    if (Array.isArray(data.classes)) {
        scanData.classes = data.classes;
    }
    if ('classes_file_exists' in data) {
        scanData.classes_file_exists = Boolean(data.classes_file_exists);
    }
    if (data.classes_path) {
        scanData.classes_path = data.classes_path;
    }
    if ('shared_classes_active' in data && scanData.shared_classes_info) {
        scanData.shared_classes_info.active = Boolean(data.shared_classes_active);
    }
    if (data.last_backup) {
        scanData.last_backup = data.last_backup;
    }

    // 同步維護 step-load 的 issue_groups（移除該 stem 的舊標籤問題）
    if (Array.isArray(scanData.issue_groups)) {
        const dynamicCodes = new Set(['MISSING_LABEL', 'EMPTY_LABEL', 'CLASS_OUT_OF_RANGE', 'FORMAT_ERR', 'COORD_ABNORMAL', 'DUPLICATE_BOX']);
        scanData.issue_groups.forEach(grp => {
            if (dynamicCodes.has(grp.code) && Array.isArray(grp.stems)) {
                grp.stems = grp.stems.filter(st => st !== patch.stem);
                grp.count = grp.stems.length;
            }
        });
        scanData.issue_groups = scanData.issue_groups.filter(grp => grp.count > 0);
    }

    recomputeClientSummaryCounts();
    recordPrevFolderClassesHint(scanData);
    renderSharedClassesGuidance();
}

async function nudgeSelectedBoxOnCanvas(dxPixels, dyPixels) {
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (isSavingCanvas || lastSaveFailed || reviewUpdatePending || !item || !Array.isArray(item.boxes)) return false;
    if (selectedBoxIndex < 0 || selectedBoxIndex >= item.boxes.length) return false;
    const b = item.boxes[selectedBoxIndex];
    const imgW = Math.max(1, canvasRenderState?.imgW || item.img_width || 640);
    const imgH = Math.max(1, canvasRenderState?.imgH || item.img_height || 480);
    const nextXc = Math.max(b.w / 2, Math.min(1 - b.w / 2, b.xc + (dxPixels / imgW)));
    const nextYc = Math.max(b.h / 2, Math.min(1 - b.h / 2, b.yc + (dyPixels / imgH)));
    if (Math.abs(nextXc - b.xc) < 1e-7 && Math.abs(nextYc - b.yc) < 1e-7) return true;
    const snap = snapshotItemForUndo(item);
    b.xc = nextXc;
    b.yc = nextYc;
    b.x_center = nextXc;
    b.y_center = nextYc;
    markCanvasDraftDirty(item, snap);
    return true;
}

async function deleteSelectedBoxOnCanvas() {
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (isSavingCanvas || lastSaveFailed || reviewUpdatePending || !item || selectedBoxIndex < 0 || selectedBoxIndex >= item.boxes.length) return;
    const snap = snapshotItemForUndo(item);
    item.boxes.splice(selectedBoxIndex, 1);
    selectedBoxIndex = -1;
    markCanvasDraftDirty(item, snap);
}

async function saveCanvasBoxesToDisk(stem, boxes, options = {}) {
    isSavingCanvas = true;
    lastSaveFailed = false;
    const workspace = scanData?.workspace_id;
    const confirmAfterSave = Boolean(options.confirm);
    const definedClasses = Array.isArray(scanData?.classes) ? [...scanData.classes] : [];
    pendingSavePayload = {
        workspace,
        stem,
        boxes: JSON.parse(JSON.stringify(boxes)),
        confirm: confirmAfterSave
    };
    updateSaveIndicator('saving', confirmAfterSave ? '[...] 儲存並確認中' : '[...] 儲存中');

    activeSavePromise = (async () => {
        try {
            const res = await workspaceFetch('/api/save_single_label', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    stem,
                    boxes,
                    confirm: confirmAfterSave,
                    fast_single: true,
                    defined_classes: definedClasses
                })
            });
            const data = await res.json();
            if (workspace !== scanData?.workspace_id) return false;
            if (!data.ok) {
                throw new Error(data.error || '寫入標記檔失敗');
            }
            if (data.fast_single && data.item_patch) {
                applySingleSavePatch(data);
            } else if (data.scan) {
                scanData = data.scan;
            }
            if (dirtyCanvasStem === stem) {
                dirtyCanvasStem = null;
                dirtyCanvasOrigState = null;
                localCanvasUndoStack = [];
            }
            isSavingCanvas = false;
            lastSaveFailed = false;
            pendingSavePayload = null;
            updateSaveIndicator('saved');
            updateHeaderAndNavBadges();
            renderLoadStepSummary();
            if (!options.skipInspectorRender) {
                renderStudioFileList();
                renderInspectorAndCanvas();
            }
            return true;
        } catch (err) {
            if (workspace !== scanData?.workspace_id) return false;
            isSavingCanvas = false;
            lastSaveFailed = true;
            updateSaveIndicator('error', '[✕] 儲存失敗（點擊重試）');
            showToast(`儲存標記檔失敗：${err.message}`, 'error');
            return false;
        }
    })();

    return activeSavePromise;
}

async function retryLastFailedSave() {
    if (!pendingSavePayload || pendingSavePayload.workspace !== scanData?.workspace_id) return false;
    return await saveCanvasBoxesToDisk(
        pendingSavePayload.stem,
        pendingSavePayload.boxes,
        { confirm: Boolean(pendingSavePayload.confirm) }
    );
}

// ============================================================================
// 審核確認、標記需修正、切換上下張與鍵盤快捷鍵
// ============================================================================
async function runReviewUpdate(action) {
    if (reviewUpdatePending) return;
    reviewUpdatePending = true;
    try { await action(); }
    finally { reviewUpdatePending = false; }
}

async function confirmCurrentAndNext() {
    return runReviewUpdate(confirmCurrentAndNextInternal);
}

async function confirmCurrentAndNextInternal() {
    if (!scanData || !activeStem) return;

    const workspace = scanData.workspace_id;
    const stem = activeStem;

    // 1. 若有進行中的儲存，先等待完成；若上次儲存失敗，先重試，失敗絕不跳下一張
    if (isSavingCanvas && activeSavePromise) {
        const ok = await activeSavePromise;
        if (!ok || workspace !== scanData?.workspace_id || stem !== activeStem) return;
    }
    if (lastSaveFailed) {
        const retryOk = await retryLastFailedSave();
        if (!retryOk || workspace !== scanData?.workspace_id || stem !== activeStem) return;
    }

    const item = scanData.items.find(i => i.stem === activeStem);
    if (!item || item.box_count === 0 || item.review_status === 'confirmed') return;

    if (item.has_blocking_error) {
        showToast(`無法標記為已確認：此張照片尚有格式錯誤 (${item.format_label})，請先修正。`, 'error');
        return;
    }

    // 2. 若此張照片有尚未寫入硬碟的畫布微調，於按下「確認並下一張 (C)」時一次寫入並確認完成！
    if (dirtyCanvasStem === stem) {
        const ok = await saveCanvasBoxesToDisk(item.stem, item.boxes, { confirm: true, skipInspectorRender: true });
        if (!ok || workspace !== scanData?.workspace_id || stem !== activeStem) return;
        reviewUpdatePending = false;
        advanceToNextUnconfirmedOrNext();
        return;
    } else if (dirtyCanvasStem && dirtyCanvasStem !== stem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed || workspace !== scanData?.workspace_id || stem !== activeStem) return;
    }

    const allowEmpty = (item.box_count === 0);
    updateSaveIndicator('saving', '[...] 正在儲存確認狀態');

    try {
        const res = await workspaceFetch('/api/update_review_state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stem: item.stem,
                state: 'confirmed',
                allow_empty: allowEmpty
            })
        });
        const data = await res.json();
        if (workspace !== scanData?.workspace_id || stem !== activeStem) return;
        if (!data.ok) {
            updateSaveIndicator('error', '確認失敗・重試', confirmCurrentAndNext);
            showToast(data.error || '無法確認此照片', 'error');
            return;
        }

        // 若確認無物件照片新建了 0-byte .txt，重新掃描同步狀態
        if (!item.has_label && allowEmpty) {
            await scanCurrentWorkspace({ keepStep: true, silent: true, refreshBoundWorkspace: true });
            if (workspace !== scanData?.workspace_id || stem !== activeStem) return;
        } else {
            item.review_state = 'confirmed';
            item.review_status = 'confirmed';
            item.review_label = '已確認';
            recomputeClientSummaryCounts();
        }

        updateSaveIndicator('saved');
        updateHeaderAndNavBadges();
        renderLoadStepSummary();
        reviewUpdatePending = false;
        advanceToNextUnconfirmedOrNext();
    } catch (e) {
        if (workspace !== scanData?.workspace_id || stem !== activeStem) return;
        updateSaveIndicator('error', '確認失敗・重試', confirmCurrentAndNext);
        showToast('確認失敗，請重試。', 'error');
    }
}

async function markCurrentReviewState(targetState) {
    return;
    return runReviewUpdate(() => markCurrentReviewStateInternal(targetState));
}

async function markCurrentReviewStateInternal(targetState) {
    if (!scanData || !activeStem) return;
    const workspace = scanData.workspace_id;
    const stem = activeStem;
    if (lastSaveFailed && !(await retryLastFailedSave())) return;
    if (workspace !== scanData?.workspace_id || stem !== activeStem) return;
    if (isSavingCanvas && activeSavePromise) {
        const ok = await activeSavePromise;
        if (!ok || workspace !== scanData?.workspace_id || stem !== activeStem) return;
    }

    const item = scanData.items.find(i => i.stem === activeStem);
    if (!item) return;

    try {
        const res = await workspaceFetch('/api/update_review_state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                stem: item.stem,
                state: targetState
            })
        });
        const data = await res.json();
        if (workspace !== scanData?.workspace_id || stem !== activeStem) return;
        if (!data.ok) {
            showToast(data.error || '更新狀態失敗', 'error');
            return;
        }

        item.review_state = 'needs_refinement';
        item.review_status = 'needs_fix';
        item.review_label = '需修正';
        recomputeClientSummaryCounts();
        updateSaveIndicator('saved');
        updateHeaderAndNavBadges();
        renderLoadStepSummary();
        reviewUpdatePending = false;
        advanceToNextUnconfirmedOrNext();
    } catch (e) {
        if (workspace !== scanData?.workspace_id || stem !== activeStem) return;
        showToast('更新審核狀態失敗', 'error');
    }
}

function recomputeClientSummaryCounts() {
    if (!scanData || !scanData.items) return;
    const photos = scanData.items.filter(i => i.has_image);
    const total = photos.length;
    const confirmed = photos.filter(i => i.review_status === 'confirmed').length;
    const pending = photos.filter(i => i.review_status === 'pending_review').length;
    const needsFix = photos.filter(i => i.review_status === 'needs_fix').length;
    const unlabeled = photos.filter(i => i.review_status === 'unlabeled').length;

    scanData.summary.review_confirmed_count = confirmed;
    scanData.summary.review_pending_count = pending;
    scanData.summary.review_needs_fix_count = needsFix;
    scanData.summary.confirmed_count = confirmed;
    scanData.summary.pending_review_count = pending;
    scanData.summary.needs_fix_count = needsFix;
    scanData.summary.unlabeled_count = unlabeled;
    scanData.summary.reference_candidate_count = photos.filter(i => i.is_valid_reference).length;
    scanData.summary.paired_count = photos.filter(i => i.has_label).length;
    scanData.summary.paired_with_boxes_count = photos.filter(i => i.has_label && i.box_count > 0).length;
    scanData.summary.empty_label_count = photos.filter(i => i.has_label && i.box_count === 0).length;
    scanData.summary.confirmed_pct = total > 0 ? Math.round((confirmed / total) * 1000) / 10 : 0;
}

function advanceToNextUnconfirmedOrNext() {
    const list = getActiveReviewItemsList();
    if (!list.length) { refreshReviewSelection(); return; }
    const curIdx = list.findIndex(i => i.stem === activeStem);

    // 優先往後找下一張尚未 confirmed 的照片
    for (let offset = 1; offset < list.length + (curIdx === -1 ? 1 : 0); offset++) {
        const candidate = list[(curIdx + offset) % list.length];
        if (candidate.review_status !== 'confirmed') {
            selectReviewItem(candidate.stem);
            return;
        }
    }
    // 若清單內全部皆已 confirmed，停在當前或更新完成橫幅
    renderStudioFileList();
    renderInspectorAndCanvas();
    const scopeItems = getReviewScopePhotos();
    if (scopeItems.length && scopeItems.every(item => item.review_status === 'confirmed')) {
        showToast('全部照片已確認。', 'success');
    }
}

function navigateItem(delta) {
    const list = getActiveReviewItemsList();
    if (!list.length) return;
    const curIdx = list.findIndex(i => i.stem === activeStem);
    const nextIdx = (curIdx + delta + list.length) % list.length;
    selectReviewItem(list[nextIdx].stem);
}

async function setCurrentAsMaster() {
    if (!scanData || !activeStem) return;
    if (dirtyCanvasStem === activeStem) {
        const flushed = await flushUnsavedCanvasDraftIfNeeded();
        if (!flushed) return;
    }
    const item = scanData?.items?.find(i => i.stem === activeStem);
    if (!item) return;
    if (!item.is_valid_reference) {
        showToast('參考照片必須至少有 1 個標記框且無格式錯誤', 'warn');
        return;
    }
    masterStem = item.stem;
    copySelectedStems.delete(masterStem);
    renderStudioFileList();
    renderInspectorAndCanvas();
    saveSessionProgress();
}

function initKeyboardShortcuts() {
    window.addEventListener('keydown', (e) => {
        // 1. 避免長按重複觸發 (防止長按 C 連續確認多張照片)
        if (handleModalKey(e)) return;
        if (typeof handleGuidedTourKey === 'function' && handleGuidedTourKey(e)) return;
        if (e.isComposing) return;

        // Ctrl+Z / ⌘+Z：還原上一步（輸入框內保留瀏覽器原生的文字復原；不連續觸發）
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
            const zTag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
            if (zTag === 'INPUT' || zTag === 'TEXTAREA' || zTag === 'SELECT' || e.target?.isContentEditable) return;
            e.preventDefault();
            if (e.repeat) return;
            const undoBtn = document.getElementById('btnQuickUndo');
            if (!undoBtn || undoBtn.disabled) {
                showToast('目前沒有可還原的操作', 'info');
                return;
            }
            if (typeof isSavingCanvas !== 'undefined' && isSavingCanvas) {
                showToast('正在儲存，請稍候再還原', 'info');
                return;
            }
            handleUndoLast();
            return;
        }

        if (e.repeat) return;
        if (e.ctrlKey || e.metaKey || e.altKey) return;

        // 2. 在輸入框、下拉選單或彈窗開啟時不觸發畫布快捷鍵
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable ||
            ((e.key === ' ' || e.key === 'Enter') && (tag === 'BUTTON' || tag === 'SUMMARY'))) {
            return;
        }

        if (e.key === '?') {
            e.preventDefault();
            openModal('shortcutModal');
            return;
        }

        // 以下快捷鍵僅在「3. 檢查與微調」頁面生效
        if (currentStep !== 'review') return;

        // 方向鍵微調已選取標記框位置（一般 1px；按住 Shift 每次 10px）
        if (selectedBoxIndex >= 0 && !e.target?.classList?.contains('photo-list-resize')) {
            const stepPx = e.shiftKey ? 10 : 1;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                nudgeSelectedBoxOnCanvas(-stepPx, 0);
                return;
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                nudgeSelectedBoxOnCanvas(stepPx, 0);
                return;
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                nudgeSelectedBoxOnCanvas(0, -stepPx);
                return;
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                nudgeSelectedBoxOnCanvas(0, stepPx);
                return;
            }
        }

        if (e.key === 'Escape' && isDrawBoxMode) {
            e.preventDefault();
            toggleDrawBoxMode(false);
        } else if (e.key === 'Escape' && document.getElementById('reviewRightSidebar').classList.contains('expanded')) {
            e.preventDefault();
            toggleReviewSidebar('right', e.target);
        } else if (e.key === 'Escape' && selectedBoxIndex >= 0) {
            e.preventDefault();
            selectedBoxIndex = -1;
            renderInspectorAndCanvas();
        } else if (e.key === 'w' || e.key === 'W') {
            e.preventDefault();
            toggleDrawBoxMode();
        } else if (e.key === 'm' || e.key === 'M') {
            e.preventDefault();
            toggleMagnifierLoupe();
        } else if (e.key === 'b' || e.key === 'B') {
            e.preventDefault();
            duplicateSelectedBoxOnCanvas();
        } else if (e.key === 'd' || e.key === 'D') {
            e.preventDefault();
            navigateItem(1);
        } else if (e.key === 'a' || e.key === 'A') {
            e.preventDefault();
            navigateItem(-1);
        } else if (e.key === 'c' || e.key === 'C') {
            e.preventDefault();
            confirmCurrentAndNext();
        } else if (e.key === 'r' || e.key === 'R') {
            e.preventDefault();
            return;
        } else if (e.key === 'v' || e.key === 'V') {
            e.preventDefault();
            const order = ['single', 'side_by_side'];
            const nextMode = order[(order.indexOf(previewMode) + 1) % order.length];
            setPreviewMode(nextMode);
        } else if (e.key === ' ') {
            e.preventDefault();
            setCurrentAsMaster();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectedBoxIndex >= 0) {
                e.preventDefault();
                deleteSelectedBoxOnCanvas();
            }
        }
    });
}

// ============================================================================
// 輔助工具彈窗：類別修正、操作紀錄與還原
// ============================================================================
let activeModal = null;
let modalOpener = null;

function handleModalKey(event) {
    if (!activeModal) return false;
    if (event.key === 'Escape') {
        event.preventDefault();
        if (activeModal.id === 'newBoxClassModal') {
            cancelNewBoxClassModal();
        } else if (activeModal.id === 'sharedClassesSetupModal') {
            dismissSharedClassesGuide();
        } else {
            closeModal(activeModal.id);
        }
    } else if (event.key === 'Tab') {
        const controls = Array.from(activeModal.querySelectorAll('button, input, select, textarea, summary, a[href]'))
            .filter(control => !control.disabled && control.getClientRects().length);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !activeModal.contains(document.activeElement))) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !activeModal.contains(document.activeElement))) {
            event.preventDefault();
            first?.focus();
        }
    }
    return true;
}

function openModal(modalId) {
    if (modalId === 'remapModal' && dirtyCanvasStem) {
        flushUnsavedCanvasDraftIfNeeded().then(ok => {
            if (ok) openModal('remapModal');
        });
        return;
    }
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const tools = document.querySelector('.utility-tools');
    if (activeModal) closeModal(activeModal.id);
    modalOpener = tools?.contains(document.activeElement) ? tools.querySelector('summary') : document.activeElement;
    tools?.removeAttribute('open');
    if (modalId === 'remapModal') renderClassRemapEditor();
    activeModal = modal;
    modal.style.display = 'flex';
    modal.querySelector('.btn-close')?.focus();
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.style.display = 'none';
    if (modal === activeModal) {
        activeModal = null;
        modalOpener?.focus();
        modalOpener = null;
    }
}

function toggleFolderDetailModal() {
    openModal('folderDetailModal');
}

function renderClassRemapEditor() {
    const wrap = document.getElementById('classRemapEditorWrap');
    if (!wrap || !scanData || !scanData.ok) return;

    const sharedWarnEl = document.getElementById('remapSharedClassesWarning');
    if (sharedWarnEl) {
        const sInfo = scanData.shared_classes_info;
        if (sInfo && sInfo.active) {
            sharedWarnEl.style.display = 'block';
            sharedWarnEl.innerHTML = `⚠️ 共用模式建議只改名稱；合併或刪除不會同步更新其他資料夾的標記檔。`;
        } else {
            sharedWarnEl.style.display = 'none';
            sharedWarnEl.innerHTML = '';
        }
    }

    const usedClassIds = new Set();
    scanData.classes.forEach((_, idx) => usedClassIds.add(idx));
    scanData.items.forEach(item => {
        item.boxes.forEach(b => usedClassIds.add(b.class_id));
    });

    const sortedIds = Array.from(usedClassIds).sort((a, b) => a - b);
    if (sortedIds.length === 0) {
        wrap.innerHTML = '<div style="padding:16px;" class="muted-text">目前沒有任何類別定義或標記框。</div>';
        document.getElementById('classRemapResult').innerHTML = '';
        document.getElementById('classRemapPreviewBox').innerHTML = '';
        document.getElementById('btnExecRemap').disabled = true;
        return;
    }

    const nameOf = cid => (cid < scanData.classes.length ? scanData.classes[cid] : '');
    const boxCountOf = cid => scanData.items.reduce((acc, it) => acc + it.boxes.filter(b => b.class_id === cid).length, 0);
    const photoCountOf = cid => scanData.items.filter(it => it.boxes.some(b => b.class_id === cid)).length;

    const rowsHtml = sortedIds.map(cid => {
        const curName = nameOf(cid);
        const boxCnt = boxCountOf(cid);
        const photoCnt = photoCountOf(cid);
        const canMerge = sortedIds.length >= 2;
        const targetOptions = sortedIds
            .filter(other => other !== cid)
            .map(other => `<option value="${other}">ID ${other} · ${escapeHtml(nameOf(other) || `未定義(${other})`)}</option>`)
            .join('');
        return `
            <tr class="remap-row" data-orig-id="${cid}" data-box-count="${boxCnt}" data-orig-name="${escapeHtml(curName)}" data-action="keep">
                <td class="remap-col-class">
                    <div class="remap-class-cell">
                        <span class="remap-id-badge">ID ${cid}</span>
                        <span class="remap-cur-name" title="${escapeHtml(curName || '未定義名稱')}">${curName ? `<strong>${escapeHtml(curName)}</strong>` : '<span class="text-red">[!] 未定義名稱</span>'}</span>
                    </div>
                </td>
                <td class="remap-col-count"><strong>${boxCnt}</strong> 個框 <span class="muted-text">(${photoCnt} 張照片)</span></td>
                <td class="remap-col-action">
                    <div class="remap-action-seg" role="group" aria-label="類別 ${cid} 的處理動作">
                        <button type="button" class="remap-seg-btn active" data-act="keep" aria-pressed="true" onclick="setRemapRowAction(this, 'keep')">改名／保留</button>
                        <button type="button" class="remap-seg-btn" data-act="merge" aria-pressed="false"${canMerge ? '' : ' disabled title="至少需有 2 個類別才能合併"'} onclick="setRemapRowAction(this, 'merge')">合併</button>
                        <button type="button" class="remap-seg-btn remap-seg-danger" data-act="delete" aria-pressed="false" onclick="setRemapRowAction(this, 'delete')">刪除</button>
                    </div>
                </td>
                <td class="remap-col-setting">
                    <div class="remap-setting-pane">
                        <div class="remap-setting-group remap-setting-keep">
                            <span class="remap-field-label">名稱：</span>
                            <input type="text" class="form-input-sm remap-new-name" aria-label="類別 ${cid} 的新名稱" value="${escapeHtml(curName || `class_${cid}`)}" placeholder="輸入類別名稱">
                        </div>
                        <div class="remap-setting-group remap-setting-merge" hidden>
                            <span class="remap-field-label">將標記框併入：</span>
                            <select class="form-select-sm remap-merge-target" aria-label="類別 ${cid} 要合併到的目標類別">${targetOptions}</select>
                        </div>
                        <div class="remap-setting-group remap-setting-delete" hidden>
                            <span class="remap-delete-note">將移除 ${boxCnt} 個標記框（共 ${photoCnt} 張照片）</span>
                        </div>
                        <span class="remap-col-result"></span>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    wrap.innerHTML = `
        <table class="data-table remap-table">
            <thead>
                <tr>
                    <th class="remap-col-class">目前類別</th>
                    <th class="remap-col-count">標記框數量</th>
                    <th class="remap-col-action">選擇要執行的動作</th>
                    <th class="remap-col-setting">動作設定與結果</th>
                </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
        </table>
    `;
    validatedRemapPayload = null;
    wrap.oninput = () => { updateRemapSummary(); scheduleRemapPreview(); };
    wrap.onchange = () => { updateRemapSummary(); scheduleRemapPreview(); };
    updateRemapSummary();
    scheduleRemapPreview();
}

function setRemapRowAction(btnEl, action) {
    const tr = btnEl.closest('tr');
    if (!tr) return;
    tr.dataset.action = action;
    tr.querySelectorAll('.remap-seg-btn').forEach(b => {
        const isAct = b.dataset.act === action;
        b.classList.toggle('active', isAct);
        b.setAttribute('aria-pressed', String(isAct));
    });
    tr.querySelector('.remap-setting-keep').hidden = action !== 'keep';
    tr.querySelector('.remap-setting-merge').hidden = action !== 'merge';
    tr.querySelector('.remap-setting-delete').hidden = action !== 'delete';
    if (action === 'keep') tr.querySelector('.remap-new-name')?.focus();
    else if (action === 'merge') tr.querySelector('.remap-merge-target')?.focus();
    updateRemapSummary();
    scheduleRemapPreview();
}

let validatedRemapPayload = null;
let remapPreviewTimer = null;

function invalidateRemapPreview() {
    validatedRemapPayload = null;
    if (remapPreviewTimer) {
        clearTimeout(remapPreviewTimer);
        remapPreviewTimer = null;
    }
    const btn = document.getElementById('btnExecRemap');
    if (btn) btn.disabled = true;
}

function scheduleRemapPreview() {
    if (remapPreviewTimer) clearTimeout(remapPreviewTimer);
    remapPreviewTimer = setTimeout(() => {
        previewClassRemapOperation({ silent: true });
    }, 150);
}

/**
 * 依使用者在表格中的選擇，計算類別修正方案：
 * - 改名／保留：維持類別（可改名稱）
 * - 合併到其他類別：此類別的標記框改歸入目標類別，原類別編號移除
 * - 刪除此類別：移除此類別的所有標記框
 * classes.txt 的編號必須連續，因此保留下來的類別會依原順序自動重新編號。
 */
function resolveRemapPlan() {
    const rows = Array.from(document.querySelectorAll('.remap-row')).map(tr => ({
        id: parseInt(tr.dataset.origId, 10),
        boxCount: parseInt(tr.dataset.boxCount, 10) || 0,
        origName: tr.dataset.origName || '',
        action: tr.dataset.action || 'keep',
        name: tr.querySelector('.remap-new-name').value.trim(),
        mergeTo: parseInt(tr.querySelector('.remap-merge-target').value, 10)
    }));
    const byId = new Map(rows.map(r => [r.id, r]));
    const errors = [];

    // 解析合併鏈，找出最終保留的類別
    const finalOf = new Map();
    rows.forEach(r => {
        if (r.action === 'delete') { finalOf.set(r.id, null); return; }
        let cur = r;
        const seen = new Set();
        while (cur && cur.action === 'merge') {
            if (seen.has(cur.id)) { errors.push(`類別 ID ${r.id} 的合併設定形成循環，請改選其他目標。`); cur = null; break; }
            seen.add(cur.id);
            cur = byId.get(cur.mergeTo);
        }
        if (cur && cur.action === 'delete') {
            errors.push(`類別 ID ${r.id} 要合併到的目標類別 ID ${cur.id} 已設為刪除，請改選其他目標。`);
            cur = null;
        }
        finalOf.set(r.id, cur ? cur.id : undefined);
    });

    // 保留下來的類別依原順序重新編號
    const keepers = rows.filter(r => r.action === 'keep');
    const newIdOfKeeper = new Map(keepers.map((r, idx) => [r.id, idx]));
    const newClasses = keepers.map(r => r.name || `class_${r.id}`);

    const seenNames = new Map();
    newClasses.forEach((name, idx) => {
        if (seenNames.has(name)) errors.push(`類別名稱「${name}」重複，請改用不同名稱或選擇「合併到其他類別」。`);
        seenNames.set(name, idx);
    });
    if (keepers.length === 0) errors.push('至少要保留一個類別。');

    const mapping = {};
    const resultText = new Map();
    let hasChanges = false;
    rows.forEach(r => {
        const fin = finalOf.get(r.id);
        if (fin === null) {
            mapping[r.id] = null;
            hasChanges = true;
            resultText.set(r.id, { text: '', tone: 'delete' });
        } else if (fin === undefined) {
            resultText.set(r.id, { text: '設定有誤，請檢查', tone: 'error' });
        } else {
            const nid = newIdOfKeeper.get(fin);
            mapping[r.id] = nid;
            const keeperRow = byId.get(fin);
            const finalName = (keeperRow && keeperRow.name) ? keeperRow.name : `class_${fin}`;
            if (r.action === 'merge') {
                hasChanges = true;
                resultText.set(r.id, { text: `併入 ID ${nid} (${finalName})`, tone: 'merge' });
            } else {
                const idChanged = nid !== r.id;
                const nameChanged = finalName !== r.origName;
                if (idChanged || nameChanged) hasChanges = true;
                if (!idChanged && !nameChanged) {
                    resultText.set(r.id, { text: '維持原設定', tone: 'same' });
                } else if (!idChanged && nameChanged) {
                    resultText.set(r.id, { text: `改名為「${finalName}」`, tone: 'renumber' });
                } else if (idChanged && !nameChanged) {
                    resultText.set(r.id, { text: `編號改為 ID ${nid}`, tone: 'renumber' });
                } else {
                    resultText.set(r.id, { text: `改名並改為 ID ${nid}`, tone: 'renumber' });
                }
            }
        }
    });

    return { ok: errors.length === 0, errors, mapping, new_classes: newClasses, rows, resultText, hasChanges };
}

function updateRemapSummary() {
    const box = document.getElementById('classRemapResult');
    if (!box) return;
    const plan = resolveRemapPlan();
    plan.rows.forEach(r => {
        const cell = document.querySelector(`.remap-row[data-orig-id="${r.id}"] .remap-col-result`);
        const info = plan.resultText.get(r.id);
        if (!cell) return;
        if (info && info.text) {
            cell.innerHTML = `<span class="remap-result-tag tone-${info.tone}">${escapeHtml(info.text)}</span>`;
        } else {
            cell.innerHTML = '';
        }
    });
    if (!plan.ok) {
        box.className = 'remap-result has-error';
        box.innerHTML = plan.errors.map(e => `<div>[✕] ${escapeHtml(e)}</div>`).join('');
    } else {
        box.className = 'remap-result';
        const list = plan.new_classes.map((n, i) => `<span class="remap-final-item"><span class="remap-final-id">ID ${i}</span> <strong>${escapeHtml(n)}</strong></span>`).join('');
        box.innerHTML = `<div class="remap-final-title">修正後的類別清單（classes.txt）：</div><div class="remap-final-list">${list}</div>`;
    }
    const execBtn = document.getElementById('btnExecRemap');
    if (execBtn) execBtn.disabled = !plan.ok || !plan.hasChanges;
    if (!plan.hasChanges && plan.ok) {
        document.getElementById('classRemapPreviewBox').innerHTML =
            '<span class="muted-text">尚未變更任何設定。可直接修改「名稱」輸入框改名，或點選「合併到其他類別」、「刪除此類別」。</span>';
    }
}

function collectClassRemapPayload() {
    const plan = resolveRemapPlan();
    if (!plan.ok) return null;
    return { mapping: plan.mapping, new_classes: plan.new_classes };
}

async function previewClassRemapOperation(options = {}) {
    const plan = resolveRemapPlan();
    if (!plan.ok) {
        if (!options.silent) showToast('請先修正類別設定中的問題。', 'warn');
        return false;
    }
    if (!plan.hasChanges) {
        validatedRemapPayload = null;
        return false;
    }
    const payload = { mapping: plan.mapping, new_classes: plan.new_classes };
    const fingerprint = JSON.stringify(payload);
    try {
        const res = await workspaceFetch('/api/class_remap/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: fingerprint
        });
        const data = await res.json();
        if (fingerprint !== JSON.stringify(collectClassRemapPayload())) return false;
        const errors = [...(data.validation_errors || []), ...(data.continuity_warnings || [])];
        if (!res.ok || !data.ok || errors.length) {
            throw new Error(data.error || errors.join('；') || '類別修正預覽失敗');
        }
        const p = data.preview;
        document.getElementById('classRemapPreviewBox').innerHTML = `
            <div><strong>預計影響範圍：</strong>將更新 <strong>${p.affected_files_count}</strong> 個標記檔（轉移 <strong>${p.remapped_boxes_count}</strong> 框 · 刪除 <strong>${p.deleted_boxes_count}</strong> 框） · 修改名稱 <strong>${p.rename_only_classes.length}</strong> 項（執行前會自動建立備份，隨時可按 Ctrl+Z 還原）</div>`;
        validatedRemapPayload = fingerprint;
        document.getElementById('btnExecRemap').disabled = false;
        return true;
    } catch (error) {
        document.getElementById('classRemapPreviewBox').textContent = error.message;
        if (!options.silent) showToast(error.message, 'error');
        return false;
    }
}

async function executeClassRemapOperation() {
    const payload = collectClassRemapPayload();
    if (!payload) {
        updateRemapSummary();
        showToast('請先修正類別設定中的問題。', 'warn');
        return;
    }
    const fingerprint = JSON.stringify(payload);
    if (validatedRemapPayload !== fingerprint) {
        const ok = await previewClassRemapOperation({ silent: false });
        if (!ok) return;
    }
    const button = document.getElementById('btnExecRemap');
    button.disabled = true;
    try {
        const res = await workspaceFetch('/api/class_remap/execute', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '類別修正執行失敗');
        scanData = data.scan;
        updateHeaderAndNavBadges();
        renderLoadStepSummary();
        if (currentStep === 'apply') renderBatchApplyStep();
        if (currentStep === 'review') {
            ensureValidActiveItemForReview();
            renderStudioFileList();
            renderInspectorAndCanvas();
        }
        closeModal('remapModal');
        showToast(`類別修正完成（更新 ${data.results.modified_files_count} 個標記檔），已自動建立備份。`, 'success');
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        validatedRemapPayload = null;
        button.disabled = true;
    }
}

let undoInProgress = false;

async function handleUndoLast() {
    if (undoInProgress) return;
    if (dirtyCanvasStem && localCanvasUndoStack.length > 0 && dirtyCanvasStem === activeStem) {
        const curItem = scanData?.items?.find(i => i.stem === activeStem);
        if (curItem) {
            const snap = localCanvasUndoStack.pop();
            if (localCanvasUndoStack.length === 0) {
                restoreItemFromUndoSnapshot(curItem, dirtyCanvasOrigState || snap);
                dirtyCanvasStem = null;
                dirtyCanvasOrigState = null;
            } else {
                curItem.boxes = JSON.parse(JSON.stringify(snap.boxes || []));
                syncItemLocalDraftState(curItem);
            }
            if (selectedBoxIndex >= (curItem.boxes?.length || 0)) {
                selectedBoxIndex = (curItem.boxes?.length || 0) - 1;
            }
            recomputeClientSummaryCounts();
            updateHeaderAndNavBadges();
            renderLoadStepSummary();
            renderStudioFileList();
            renderInspectorAndCanvas();
            showToast('已還原畫布微調', 'info');
            return;
        }
    }
    undoInProgress = true;
    const tools = document.querySelector('.utility-tools');
    if (tools?.open) {
        tools.open = false;
        tools.querySelector('summary')?.focus();
    }
    try {
        if (dirtyCanvasStem) {
            const flushed = await flushUnsavedCanvasDraftIfNeeded();
            if (!flushed) return;
        }
        const res = await workspaceFetch('/api/undo', { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
            showToast(data.message || data.error || '目前沒有可還原的備份', 'warn');
            return;
        }
        scanData = data.scan;
        document.getElementById('applySuccessBanner').style.display = 'none';
        if (Array.isArray(scanData.session?.review_queue)) {
            reviewQueue = scanData.session.review_queue;
        }
        updateHeaderAndNavBadges();
        renderLoadStepSummary();
        if (currentStep === 'apply') renderBatchApplyStep();
        if (currentStep === 'review') {
            ensureValidActiveItemForReview();
            renderStudioFileList();
            renderInspectorAndCanvas();
        }
        showToast(`[✓] ${data.message}`, 'success');
    } catch (e) {
        showToast('執行還原時發生錯誤', 'error');
    } finally {
        undoInProgress = false;
    }
}

// ============================================================================
// 通用輔助函式
// ============================================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => {
        toast.remove();
    }, 4200);
}

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsStr(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// ============================================================================
// 互動式動態操作指引（Interactive Guided Tour）系統
// - 分別管理「照片載入後 (post_load)」與「批次套用 (batch_apply)」每日首次提示狀態
// - 優先使用瀏覽器 LocalStorage 記錄當日 YYYY-MM-DD 狀態（重整頁面仍保留，隔日自動恢復）
// - 結合動態聚光燈遮罩 (Spotlight Cutout)、智慧防遮擋定位與內嵌微動畫操作示範
// ============================================================================
const TOUR_STORAGE_PREFIX = 'yolo_guided_tour_daily_';
let activeTourType = null;
let activeTourStepIdx = 0;
let pendingPromptTourType = null;
let isTourInternalStepSwitch = false;
let tourSavedCleanupCallbacks = [];
let tourRepositionRaf = null;

function getTodayLocalDateKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getTourDailyState(tourType) {
    try {
        const raw = localStorage.getItem(TOUR_STORAGE_PREFIX + tourType);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        return parsed;
    } catch (_) {
        return null;
    }
}

function setTourDailyState(tourType, action) {
    const today = getTodayLocalDateKey();
    try {
        const prev = getTourDailyState(tourType);
        const keepHideToday = (prev && prev.date === today && prev.hide_today) || action === 'hide_today';
        const record = {
            date: today,
            prompted: true,
            hide_today: Boolean(keepHideToday),
            last_action: action,
            updated_at: Date.now()
        };
        localStorage.setItem(TOUR_STORAGE_PREFIX + tourType, JSON.stringify(record));
    } catch (_) {}
}

function shouldAutoPromptTour(tourType) {
    const today = getTodayLocalDateKey();
    const state = getTourDailyState(tourType);
    if (!state || state.date !== today) {
        return true;
    }
    if (state.hide_today || state.prompted) {
        return false;
    }
    return true;
}

function resetGuidedTourDailyState() {
    try {
        localStorage.removeItem(TOUR_STORAGE_PREFIX + 'post_load');
        localStorage.removeItem(TOUR_STORAGE_PREFIX + 'batch_apply');
    } catch (_) {}
    closeModal('guidedTourLauncherModal');
    showToast('已重設今日操作指引提示狀態，下次載入照片或進入批次套用時將再次詢問。', 'success');
}

const GUIDED_TOUR_CONFIGS = {
    post_load: {
        categoryLabel: '標記檢視指引',
        promptBadge: '操作指引',
        promptTitle: '照片已載入，要開始操作指引嗎？',
        promptDesc: '只要 30 秒，帶您快速掌握 3 個核心操作：',
        promptPoints: [
            '切換功能區與篩選待處理照片',
            '在畫布新增、拖曳調整標記框與使用放大鏡',
            '按 C 確認標記並自動換下一張'
        ],
        steps: [
            {
                stepTarget: 'review',
                selector: '.workspace-nav',
                pulseTag: '步驟 1 · 切換功能區',
                title: '1. 切換功能區',
                desc: '點選上方按鈕，即可切換「標記檢視」、「批次套用」與「類別修正」。',
                tip: '💡 做錯任何操作，都可點右上角「↩ 還原上一步 (Ctrl+Z)」復原。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：點擊按鈕切換功能</span><span>即時顯示待處理數</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill highlight-pulse">標記檢視 (待確認)</span>
                            <span class="demo-pill">批次套用 (未標記)</span>
                            <span class="demo-pill">類別修正</span>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'review',
                selector: '#reviewLeftSidebar',
                pulseTag: '步驟 2 · 篩選與選擇照片',
                title: '2. 篩選與選擇照片',
                desc: '點選上方標籤可篩選「未標記」或「待確認」的照片，點擊清單即可切換照片。',
                tip: '💡 也可在搜尋框輸入檔名快速查找。',
                onEnter() {
                    const leftBar = document.getElementById('reviewLeftSidebar');
                    if (leftBar && leftBar.classList.contains('collapsed')) {
                        leftBar.classList.remove('collapsed');
                        tourSavedCleanupCallbacks.push(() => leftBar.classList.add('collapsed'));
                    }
                },
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：點選標籤快速篩選</span><span>點擊清單切換照片</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill">全部</span>
                            <span class="demo-pill">未標記</span>
                            <span class="demo-pill highlight-pulse">待確認 ✓</span>
                            <span class="demo-pill">已確認</span>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'review',
                selector: '#canvasViewport',
                pulseTag: '步驟 3 · 調整標記框',
                title: '3. 拖曳與微調標記框',
                desc: '點擊標記框可拖曳移動，或拉動周圍白點調整大小；調整完按 C 確認並儲存。',
                tip: '💡 按方向鍵 ↑↓←→ 可每次移動 1 像素；直接換張會自動存成草稿。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：拖曳與調整框大小</span><span>按 C 確認儲存</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-Resize-box">
                            <span class="demo-handle tl"></span><span class="demo-handle tc"></span><span class="demo-handle tr"></span>
                            <span class="demo-handle ml"></span><span class="demo-handle mr"></span>
                            <span class="demo-handle bl"></span><span class="demo-handle bc"></span><span class="demo-handle br"></span>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'review',
                selector: '.review-mode-bar',
                pulseTag: '步驟 4 · 比對與放大鏡',
                title: '4. 並排比較與放大鏡',
                desc: '點選「並排比較 (V)」可與參考照片對照；開啟「🔍 放大鏡 (M)」可放大檢視框線邊緣。',
                tip: '💡 按住 Ctrl + 滑鼠滾輪可自由放大或縮小畫面。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：游標處 4 倍放大鏡</span><span>快捷鍵 M / V</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-loupe-circle"></div>
                    </div>
                `
            },
            {
                stepTarget: 'review',
                selector: '#pinnedBoxesSidebar',
                pulseTag: '步驟 5 · 新增與管理標記框',
                title: '5. 新增、複製與刪除標記框',
                desc: '點選「＋ 新增框 (W)」可在畫布拉出新框；選取標記框後可複製 (B)、刪除 (Del) 或更換類別。',
                tip: '💡 輸入新類別名稱後會馬上存檔；要改名或刪除請點上方「類別修正」。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：新增、複製與刪除工具</span><span>快捷鍵 W / B / Del</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill highlight-pulse">＋ 新增框 (W)</span>
                            <span class="demo-pill">複製框 (B)</span>
                            <span class="demo-pill">刪除 (Del)</span>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'review',
                selector: '.review-bottom-bar',
                pulseTag: '步驟 6 · 確認並換張',
                title: '6. 確認標記並換下一張',
                desc: '檢查無誤後，點擊「確認並下一張 (C)」即可完成此張並自動跳到下一張。',
                tip: '💡 點選右側「設為參考 (Space)」，可將此張照片設為批次套用的範本。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：確認完成並跳下一張</span><span>快捷鍵 A / D / C</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill">上一張 (A)</span>
                            <span class="demo-pill highlight-pulse">[✓] 確認並下一張 (C)</span>
                            <span class="demo-pill">下一張 (D)</span>
                        </div>
                    </div>
                `
            }
        ]
    },
    batch_apply: {
        categoryLabel: '批次套用指引',
        promptBadge: '批次套用指引',
        promptTitle: '要查看「批次套用」操作指引嗎？',
        promptDesc: '只要 4 個步驟，快速將標記套用到多張相似照片：',
        promptPoints: [
            '選擇 1 張已標記的「參考照片」作為範本',
            '勾選要套用的目標照片並檢查對齊設定',
            '確認預覽結果並建立標記草稿'
        ],
        steps: [
            {
                stepTarget: 'apply',
                selector: '#referenceSelectorArea',
                pulseTag: '步驟 1 · 選擇參考照片',
                title: '1. 選擇「參考照片」',
                desc: '從下拉選單選擇一張已標記好的照片作為範本，系統會將它的標記框套用到其他照片。',
                tip: '💡 若還沒有參考照片，請先回「標記檢視」畫好 1 張並點選「設為參考」。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：選擇已標記的照片作為範本</span><span>複製來源</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill highlight-pulse">★ 參考照片</span>
                            <span class="demo-pill">➔ 提供標記框範本</span>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'apply',
                selector: '.apply-left-col',
                pulseTag: '步驟 2 · 選擇套用目標',
                title: '2. 選擇要套用的目標照片',
                desc: '點選「找出相似照片」自動勾選畫面相近的照片，或點選「全選未標記照片」，也可直接點選下方照片卡片。',
                tip: '💡 展開「相似照片設定」可調整篩選的相似度門檻。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：快速勾選目標照片</span><span>批量選取</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill highlight-pulse">找出相似照片</span>
                            <span class="demo-pill">全選未標記照片</span>
                            <span class="demo-pill">已選 N 張</span>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'apply',
                selector: '.advanced-apply-details',
                pulseTag: '步驟 3 · 檢查套用設定',
                title: '3. 檢查對齊與覆蓋設定',
                desc: '開啟「智慧局部對齊」時，就算物體位置稍微移動，也會自動幫您把框對齊。',
                tip: '⚠️ 注意：若勾選「覆蓋既有標記」，原標記會被取代（系統會自動備份）。',
                onEnter() {
                    const details = document.querySelector('.advanced-apply-details');
                    if (details && !details.open) {
                        details.open = true;
                        tourSavedCleanupCallbacks.push(() => { details.open = false; });
                    }
                },
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：自動跟隨物體微調框位</span><span>智慧局部對齊</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-zncc-wrap">
                            <div class="demo-zncc-obj">目標物體</div>
                            <div class="demo-zncc-box"></div>
                        </div>
                    </div>
                `
            },
            {
                stepTarget: 'apply',
                selector: '.apply-right-col',
                pulseTag: '步驟 4 · 預覽並建立草稿',
                title: '4. 確認預覽並建立草稿',
                desc: '先查看「寫入預覽」確認新增與略過的張數，再點擊底部「建立草稿」執行套用。',
                tip: '⚠️ 注意：批次套用後仍需到「標記檢視」逐張確認，才算正式完成。',
                demoHtml: `
                    <div class="tour-demo-header"><span>▶ 操作示範：確認預覽後點擊建立草稿</span><span>完成後逐張確認</span></div>
                    <div class="tour-demo-visual">
                        <div class="demo-pill-row">
                            <span class="demo-pill">預覽：新增 / 略過</span>
                            <span class="demo-pill highlight-pulse">建立草稿 ➔ 逐張確認</span>
                        </div>
                    </div>
                `
            }
        ]
    }
};

function isGuidedTourActive() {
    const overlay = document.getElementById('guidedTourOverlay');
    const promptModal = document.getElementById('guidedTourPromptModal');
    return Boolean(
        (overlay && overlay.style.display !== 'none') ||
        (promptModal && promptModal.style.display !== 'none')
    );
}

function maybePromptGuidedTour(tourType) {
    if (!GUIDED_TOUR_CONFIGS[tourType]) return;
    if (!scanData || !scanData.ok || (scanData.summary && scanData.summary.photo_count === 0)) return;
    if (isGuidedTourActive() || activeModal) return;
    if (!shouldAutoPromptTour(tourType)) return;

    openGuidedTourPrompt(tourType);
}

function openGuidedTourPrompt(tourType) {
    const cfg = GUIDED_TOUR_CONFIGS[tourType];
    if (!cfg) return;
    pendingPromptTourType = tourType;

    document.getElementById('tourPromptBadge').textContent = cfg.promptBadge;
    document.getElementById('tourPromptTitle').textContent = cfg.promptTitle;
    document.getElementById('tourPromptDesc').textContent = cfg.promptDesc;
    document.getElementById('tourPromptPoints').innerHTML = cfg.promptPoints
        .map(pt => `<li>${escapeHtml(pt)}</li>`)
        .join('');

    const modal = document.getElementById('guidedTourPromptModal');
    modal.style.display = 'flex';
    document.getElementById('btnTourPromptStart')?.focus();
}

function handleTourPromptChoice(choice) {
    const tourType = pendingPromptTourType;
    const modal = document.getElementById('guidedTourPromptModal');
    if (modal) modal.style.display = 'none';
    pendingPromptTourType = null;

    if (!tourType) return;

    if (choice === 'start') {
        setTourDailyState(tourType, 'start');
        startGuidedTour(tourType);
    } else if (choice === 'hide_today') {
        setTourDailyState(tourType, 'hide_today');
        showToast('已設定今日不再自動顯示此指引（隨時可點選右上角「🎓 操作指引」重新開啟）。', 'info');
    } else {
        // 暫時略過：記錄今日首次已詢問，避免同日重整頁面重複彈出干擾
        setTourDailyState(tourType, 'skip');
    }
}

function openGuidedTourLauncher() {
    if (!scanData || !scanData.ok || !scanData.summary || scanData.summary.photo_count === 0) {
        showToast('請先載入照片資料夾', 'info');
        return;
    }
    const targetTour = currentStep === 'apply' ? 'batch_apply' : 'post_load';
    startGuidedTour(targetTour);
}

function startGuidedTourFromLauncher(tourType) {
    closeModal('guidedTourLauncherModal');
    if (!scanData || !scanData.ok || !scanData.summary || scanData.summary.photo_count === 0) {
        showToast('請先載入照片資料夾', 'info');
        return;
    }
    startGuidedTour(tourType);
}

function runTourStepCleanups() {
    while (tourSavedCleanupCallbacks.length > 0) {
        const fn = tourSavedCleanupCallbacks.pop();
        try { fn(); } catch (_) {}
    }
}

function startGuidedTour(tourType) {
    const cfg = GUIDED_TOUR_CONFIGS[tourType];
    if (!cfg || !cfg.steps || !cfg.steps.length) return;

    runTourStepCleanups();
    activeTourType = tourType;
    activeTourStepIdx = 0;

    const overlay = document.getElementById('guidedTourOverlay');
    overlay.style.display = 'block';

    renderCurrentGuidedTourStep();
}

function stepGuidedTour(delta) {
    if (!activeTourType) return;
    const cfg = GUIDED_TOUR_CONFIGS[activeTourType];
    if (!cfg) return;

    const nextIdx = activeTourStepIdx + delta;
    if (nextIdx < 0) return;
    if (nextIdx >= cfg.steps.length) {
        endGuidedTour('completed');
        return;
    }

    runTourStepCleanups();
    activeTourStepIdx = nextIdx;
    renderCurrentGuidedTourStep();
}

function markCurrentTourHideToday() {
    if (!activeTourType) return;
    setTourDailyState(activeTourType, 'hide_today');
    endGuidedTour('hide_today');
}

function endGuidedTour(reason = 'closed') {
    runTourStepCleanups();
    const overlay = document.getElementById('guidedTourOverlay');
    if (overlay) overlay.style.display = 'none';
    activeTourType = null;
    activeTourStepIdx = 0;
}

function renderCurrentGuidedTourStep() {
    if (!activeTourType) return;
    const cfg = GUIDED_TOUR_CONFIGS[activeTourType];
    const step = cfg.steps[activeTourStepIdx];
    if (!step) return;

    // 確保切換至該步驟對應的頁面（不觸發自動詢問）
    if (step.stepTarget && currentStep !== step.stepTarget && scanData?.ok) {
        isTourInternalStepSwitch = true;
        try {
            switchStep(step.stepTarget);
        } finally {
            isTourInternalStepSwitch = false;
        }
    }

    if (typeof step.onEnter === 'function') {
        try { step.onEnter(); } catch (_) {}
    }

    const total = cfg.steps.length;
    document.getElementById('guidedTourStepBadge').textContent = `步驟 ${activeTourStepIdx + 1} / ${total}`;
    document.getElementById('guidedTourCategoryLabel').textContent = cfg.categoryLabel;
    document.getElementById('guidedTourPulseTag').textContent = step.pulseTag || `步驟 ${activeTourStepIdx + 1}`;
    document.getElementById('guidedTourStepTitle').textContent = step.title;

    // 支援換行段落呈現
    const descEl = document.getElementById('guidedTourStepDesc');
    descEl.innerHTML = escapeHtml(step.desc).replace(/\n/g, '<br>');

    const demoStage = document.getElementById('guidedTourDemoStage');
    if (step.demoHtml) {
        demoStage.style.display = 'block';
        demoStage.innerHTML = step.demoHtml;
    } else {
        demoStage.style.display = 'none';
        demoStage.innerHTML = '';
    }

    const tipEl = document.getElementById('guidedTourStepTip');
    if (step.tip) {
        tipEl.style.display = 'block';
        tipEl.textContent = step.tip;
    } else {
        tipEl.style.display = 'none';
    }

    // 渲染進度圓點
    const dotsEl = document.getElementById('guidedTourDots');
    dotsEl.innerHTML = cfg.steps.map((_, idx) => {
        const cls = idx === activeTourStepIdx ? 'guided-tour-dot active' : (idx < activeTourStepIdx ? 'guided-tour-dot done' : 'guided-tour-dot');
        return `<span class="${cls}"></span>`;
    }).join('');

    // 按鈕狀態切換
    const btnPrev = document.getElementById('btnTourPrev');
    const btnNext = document.getElementById('btnTourNext');
    const btnFinish = document.getElementById('btnTourFinish');
    const btnSkip = document.getElementById('btnTourSkip');

    btnPrev.disabled = (activeTourStepIdx === 0);
    const isLast = (activeTourStepIdx === total - 1);
    btnNext.style.display = isLast ? 'none' : 'inline-flex';
    btnFinish.style.display = isLast ? 'inline-flex' : 'none';
    btnSkip.style.display = isLast ? 'none' : 'inline-flex';

    // 先捲動目標元件至可視範圍並定位聚光燈與浮動卡片
    const targetEl = document.querySelector(step.selector);
    if (targetEl && typeof targetEl.scrollIntoView === 'function') {
        try {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        } catch (_) {}
    }

    positionGuidedTourElements();
    setTimeout(positionGuidedTourElements, 160);
    setTimeout(() => {
        if (isLast) btnFinish.focus();
        else btnNext.focus();
    }, 50);
}

function positionGuidedTourElements() {
    if (!activeTourType) return;
    const cfg = GUIDED_TOUR_CONFIGS[activeTourType];
    const step = cfg?.steps?.[activeTourStepIdx];
    if (!step) return;

    const spotlight = document.getElementById('guidedTourSpotlight');
    const popover = document.getElementById('guidedTourPopover');
    if (!spotlight || !popover) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const targetEl = document.querySelector(step.selector);
    const pad = 6;

    let spotRect = {
        top: Math.round(vh * 0.15),
        left: Math.round(vw * 0.15),
        width: Math.round(vw * 0.7),
        height: Math.round(vh * 0.25)
    };

    if (targetEl) {
        const r = targetEl.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            const top = Math.max(4, Math.round(r.top - pad));
            const left = Math.max(4, Math.round(r.left - pad));
            const right = Math.min(vw - 4, Math.round(r.right + pad));
            const bottom = Math.min(vh - 4, Math.round(r.bottom + pad));
            spotRect = {
                top,
                left,
                width: Math.max(40, right - left),
                height: Math.max(28, bottom - top)
            };
        }
    }

    spotlight.style.top = `${spotRect.top}px`;
    spotlight.style.left = `${spotRect.left}px`;
    spotlight.style.width = `${spotRect.width}px`;
    spotlight.style.height = `${spotRect.height}px`;
    spotlight.classList.toggle('tag-inside', spotRect.top < 32);

    // 計算浮動說明卡片最佳位置（避免遮擋目標元件，並確保在小螢幕 100% 完整落於可視範圍內）
    const popRect = popover.getBoundingClientRect();
    const popW = popRect.width || 410;
    const popH = popRect.height || 310;
    const margin = 14;
    const safeEdge = 12;

    const spaceBottom = vh - (spotRect.top + spotRect.height) - margin;
    const spaceTop = spotRect.top - margin;
    const spaceRight = vw - (spotRect.left + spotRect.width) - margin;
    const spaceLeft = spotRect.left - margin;

    let popTop = safeEdge;
    let popLeft = safeEdge;

    if (spaceBottom >= popH + safeEdge) {
        popTop = spotRect.top + spotRect.height + margin;
        popLeft = spotRect.left + (spotRect.width - popW) / 2;
    } else if (spaceTop >= popH + safeEdge) {
        popTop = spotRect.top - popH - margin;
        popLeft = spotRect.left + (spotRect.width - popW) / 2;
    } else if (spaceRight >= popW + safeEdge) {
        popLeft = spotRect.left + spotRect.width + margin;
        popTop = spotRect.top + (spotRect.height - popH) / 2;
    } else if (spaceLeft >= popW + safeEdge) {
        popLeft = spotRect.left - popW - margin;
        popTop = spotRect.top + (spotRect.height - popH) / 2;
    } else {
        // 當目標區域較大（例如主畫布或整欄）時，將說明卡片置於視窗右下或左下最不遮擋核心視覺的位置
        const candidates = [
            { top: vh - popH - safeEdge, left: vw - popW - safeEdge },
            { top: vh - popH - safeEdge, left: safeEdge },
            { top: safeEdge + 54, left: vw - popW - safeEdge }
        ];
        const chosen = candidates[0];
        popTop = chosen.top;
        popLeft = chosen.left;
    }

    popLeft = Math.max(safeEdge, Math.min(vw - popW - safeEdge, Math.round(popLeft)));
    popTop = Math.max(safeEdge, Math.min(vh - popH - safeEdge, Math.round(popTop)));

    popover.style.left = `${popLeft}px`;
    popover.style.top = `${popTop}px`;
}

function scheduleTourReposition() {
    if (!activeTourType) return;
    if (tourRepositionRaf) cancelAnimationFrame(tourRepositionRaf);
    tourRepositionRaf = requestAnimationFrame(() => {
        tourRepositionRaf = null;
        positionGuidedTourElements();
    });
}

window.addEventListener('resize', scheduleTourReposition);
window.addEventListener('scroll', scheduleTourReposition, true);

function handleGuidedTourKey(e) {
    const promptModal = document.getElementById('guidedTourPromptModal');
    if (promptModal && promptModal.style.display !== 'none') {
        if (e.key === 'Escape') {
            e.preventDefault();
            handleTourPromptChoice('skip');
        } else if (e.key === 'Enter' && document.activeElement?.tagName !== 'BUTTON') {
            e.preventDefault();
            handleTourPromptChoice('start');
        }
        return true;
    }

    const overlay = document.getElementById('guidedTourOverlay');
    if (overlay && overlay.style.display !== 'none') {
        if (e.key === 'Escape') {
            e.preventDefault();
            endGuidedTour('closed');
        } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            stepGuidedTour(1);
        } else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            stepGuidedTour(-1);
        }
        return true;
    }
    return false;
}

window.addEventListener('beforeunload', (e) => {
    if (dirtyCanvasStem || isSavingCanvas) {
        e.preventDefault();
        e.returnValue = '';
    }
});


