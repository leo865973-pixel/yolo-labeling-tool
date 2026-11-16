/**
 * AI 影像標記工具 — 純前端本地檔案系統引擎 (GitHub Pages / Serverless Local-First Engine)
 *
 * 1:1 完整移植 Python 後端 (core/scanner.py, core/grouper.py, core/batch_ops.py, app.py)：
 * - 透過瀏覽器標準 File System Access API (window.showDirectoryPicker) 直接讀寫本機資料夾
 * - 所有照片與 .txt 標記檔 100% 於本機瀏覽器記憶體內運算與寫回，零上傳、高隱私
 * - 內建記憶體練習資料集 (MemoryFsProvider)，免選資料夾即可一鍵體驗完整功能
 */
(function () {
    'use strict';

    const SHARED_RULES = (typeof window !== 'undefined' && window.YOLO_SHARED_RULES) || {
        supported_image_exts: ['.jpg', '.jpeg', '.png', '.bmp', '.webp'],
        reserved_class_filenames: ['classes.txt', 'predefined_classes.txt', 'obj.names'],
        thresholds: {
            tiny_box_min_dim: 0.005,
            oversize_box_max_dim: 1.001,
            edge_out_of_bounds_tol: 0.002,
            duplicate_box_iou: 0.88,
            aspect_ratio_mismatch: 0.015,
            default_similarity: 0.75,
            dhash_size: 8,
            virtual_list_threshold: 150
        }
    };
    const YOLO_THRESHOLDS = SHARED_RULES.thresholds;
    const SUPPORTED_IMAGE_EXTS = new Set(SHARED_RULES.supported_image_exts);
    const RESERVED_CLASS_FILENAMES = new Set(SHARED_RULES.reserved_class_filenames);

    function yieldToMainThread() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    // 自動判斷是否啟用純前端引擎：
    // 1. 明確設定 window.YOLO_WEB_MODE === true (GitHub Pages 根目錄 index.html)
    // 2. 網域為 *.github.io 或 file:// 協定
    const isStaticHost = Boolean(
        window.YOLO_WEB_MODE === true ||
        location.protocol === 'file:' ||
        location.hostname.endsWith('.github.io')
    );
    window.YOLO_WEB_MODE = isStaticHost;

    // ========================================================================
    // 1. 雜湊與基礎工具函式
    // ========================================================================
    function splitExt(filename) {
        const idx = filename.lastIndexOf('.');
        if (idx <= 0) return [filename, ''];
        return [filename.slice(0, idx), filename.slice(idx)];
    }

    function nowStr() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    }

    function makeBackupId(prefix) {
        const d = new Date();
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        return `${prefix}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}${Math.floor(Math.random() * 900 + 100)}`;
    }

    // 同步確定性雜湊 (FNV-1a 64-bit hex)，用於正規化標記內容指紋比對
    function computeNormalizedContentHash(rawText) {
        if (rawText === null || rawText === undefined) return '';
        const lines = String(rawText)
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(Boolean);
        const normalized = lines.join('\n');
        let h1 = 0xdeadbeef ^ normalized.length;
        let h2 = 0x41c6ce57 ^ normalized.length;
        for (let i = 0; i < normalized.length; i++) {
            const ch = normalized.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
    }

    function computeIoU(box1, box2) {
        const x1Min = box1.x_center - box1.width / 2.0;
        const y1Min = box1.y_center - box1.height / 2.0;
        const x1Max = box1.x_center + box1.width / 2.0;
        const y1Max = box1.y_center + box1.height / 2.0;

        const x2Min = box2.x_center - box2.width / 2.0;
        const y2Min = box2.y_center - box2.height / 2.0;
        const x2Max = box2.x_center + box2.width / 2.0;
        const y2Max = box2.y_center + box2.height / 2.0;

        const interXMin = Math.max(x1Min, x2Min);
        const interYMin = Math.max(y1Min, y2Min);
        const interXMax = Math.min(x1Max, x2Max);
        const interYMax = Math.min(y1Max, y2Max);

        const interW = Math.max(0.0, interXMax - interXMin);
        const interH = Math.max(0.0, interYMax - interYMin);
        const interArea = interW * interH;

        const area1 = Math.max(0.0, box1.width) * Math.max(0.0, box1.height);
        const area2 = Math.max(0.0, box2.width) * Math.max(0.0, box2.height);
        const unionArea = area1 + area2 - interArea;
        if (unionArea <= 1e-9) return 0.0;
        return interArea / unionArea;
    }

    // ========================================================================
    // 2. 影像尺寸、EXIF 方向與 64-bit dHash 外觀特徵計算
    // ========================================================================
    const imageMetaCache = new Map();

    function parseImageHeaderDimensionsAndExif(buffer) {
        let width = 0;
        let height = 0;
        let orientation = 1;
        try {
            const view = new DataView(buffer);
            const len = view.byteLength;
            if (len < 16) return { width: 0, height: 0, orientation: 1 };

            // 1. PNG (89 50 4E 47 0D 0A 1A 0A)
            if (view.getUint32(0, false) === 0x89504E47 && len >= 24) {
                width = view.getUint32(16, false);
                height = view.getUint32(20, false);
                return { width, height, orientation: 1 };
            }

            // 2. BMP (42 4D)
            if (view.getUint16(0, false) === 0x424D && len >= 26) {
                width = Math.abs(view.getInt32(18, true));
                height = Math.abs(view.getInt32(22, true));
                return { width, height, orientation: 1 };
            }

            // 3. WEBP (RIFF....WEBP)
            if (view.getUint32(0, false) === 0x52494646 && view.getUint32(8, false) === 0x57454250 && len >= 30) {
                const chunkType = view.getUint32(12, false);
                if (chunkType === 0x56503820 && len >= 30) { // 'VP8 '
                    width = view.getUint16(26, true) & 0x3FFF;
                    height = view.getUint16(28, true) & 0x3FFF;
                } else if (chunkType === 0x5650384C && len >= 25) { // 'VP8L'
                    const b = view.getUint32(21, true);
                    width = (b & 0x3FFF) + 1;
                    height = ((b >> 14) & 0x3FFF) + 1;
                } else if (chunkType === 0x56503858 && len >= 30) { // 'VP8X'
                    width = 1 + (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16));
                    height = 1 + (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16));
                }
                return { width, height, orientation: 1 };
            }

            // 4. JPEG (FF D8) — 同時解析 EXIF Orientation 與 SOF 寬高
            if (view.getUint16(0, false) === 0xFFD8) {
                let offset = 2;
                while (offset + 4 <= len) {
                    if (view.getUint8(offset) !== 0xFF) {
                        offset += 1;
                        continue;
                    }
                    const marker = view.getUint16(offset, false);
                    offset += 2;
                    if (marker === 0xFFD8 || marker === 0xFFD9 || (marker >= 0xFFD0 && marker <= 0xFFD7)) {
                        continue;
                    }
                    if (offset + 2 > len) break;
                    const segLen = view.getUint16(offset, false);
                    if (segLen < 2) break;

                    if (marker === 0xFFE1 && offset + 8 <= len && view.getUint32(offset + 2, false) === 0x45786966) {
                        const tiffOffset = offset + 8;
                        if (tiffOffset + 8 <= len) {
                            const little = view.getUint16(tiffOffset, false) === 0x4949;
                            const firstIfd = view.getUint32(tiffOffset + 4, little);
                            const dirStart = tiffOffset + firstIfd;
                            if (dirStart + 2 <= len) {
                                const entries = view.getUint16(dirStart, little);
                                for (let i = 0; i < entries; i++) {
                                    const entryOffset = dirStart + 2 + i * 12;
                                    if (entryOffset + 12 > len) break;
                                    if (view.getUint16(entryOffset, little) === 0x0112) {
                                        orientation = view.getUint16(entryOffset + 8, little) || 1;
                                        break;
                                    }
                                }
                            }
                        }
                    } else if (
                        (marker >= 0xFFC0 && marker <= 0xFFC3) ||
                        (marker >= 0xFFC5 && marker <= 0xFFC7) ||
                        (marker >= 0xFFC9 && marker <= 0xFFCB) ||
                        (marker >= 0xFFCD && marker <= 0xFFCF)
                    ) {
                        if (offset + 7 <= len) {
                            height = view.getUint16(offset + 3, false);
                            width = view.getUint16(offset + 5, false);
                            break;
                        }
                    }
                    offset += segLen;
                }
                if (orientation >= 5 && orientation <= 8 && width > 0 && height > 0) {
                    const tmp = width;
                    width = height;
                    height = tmp;
                }
            }
        } catch (_) {}
        return { width, height, orientation };
    }

    function computeCanvasDHash(imgEl, hashSize = 8) {
        try {
            const c = document.createElement('canvas');
            c.width = hashSize + 1;
            c.height = hashSize;
            const ctx = c.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(imgEl, 0, 0, hashSize + 1, hashSize);
            const data = ctx.getImageData(0, 0, hashSize + 1, hashSize).data;
            const gray = new Float32Array((hashSize + 1) * hashSize);
            for (let i = 0, p = 0; i < data.length; i += 4, p++) {
                gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
            }
            const bits = new Uint8Array(hashSize * hashSize);
            let k = 0;
            for (let r = 0; r < hashSize; r++) {
                const rowStart = r * (hashSize + 1);
                for (let col = 0; col < hashSize; col++) {
                    bits[k++] = gray[rowStart + col + 1] > gray[rowStart + col] ? 1 : 0;
                }
            }
            return bits;
        } catch (_) {
            return new Uint8Array(0);
        }
    }

    function computeHashMatch(h1, h2) {
        if (!h1 || !h2 || h1.length === 0 || h1.length !== h2.length) {
            return [0.0, 64, 64];
        }
        const total = h1.length;
        let dist = 0;
        for (let i = 0; i < total; i++) {
            if (h1[i] !== h2[i]) dist++;
        }
        const ratio = Number((1.0 - dist / total).toFixed(4));
        return [ratio, dist, total];
    }

    async function inspectImageBlob(cacheKey, blob, lastModified, options = {}) {
        const needDHash = Boolean(options.needDHash);
        const hit = imageMetaCache.get(cacheKey);
        if (hit && hit.lastModified === lastModified && hit.size === blob.size) {
            if (!needDHash || (hit.meta.dhash && hit.meta.dhash.length > 0)) {
                return hit.meta;
            }
        }
        const ts = (lastModified || Date.now()) / 1000.0;
        const d = new Date(lastModified || Date.now());
        const pad = (n) => String(n).padStart(2, '0');
        const dtStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

        let headerInfo = { width: 0, height: 0, orientation: 1 };
        try {
            const slice = await blob.slice(0, 65536).arrayBuffer();
            headerInfo = parseImageHeaderDimensionsAndExif(slice);
        } catch (_) {}

        const objUrl = (hit && hit.meta && hit.meta.objectUrl) ? hit.meta.objectUrl : URL.createObjectURL(blob);

        // 快速路徑：若二進位檔頭已成功解析出寬高，且初次掃描無須立即算 dHash，直接免解碼回傳（2,000+ 張照片秒級掃描）
        if (!needDHash && headerInfo.width > 0 && headerInfo.height > 0) {
            const meta = {
                width: headerInfo.width,
                height: headerInfo.height,
                aspect_ratio: headerInfo.height > 0 ? Number((headerInfo.width / headerInfo.height).toFixed(4)) : 0.0,
                has_exif_orientation: headerInfo.orientation !== 1,
                exif_orientation: headerInfo.orientation,
                timestamp: ts,
                timestamp_source: 'file_mtime',
                datetime_str: dtStr,
                read_error: null,
                dhash: hit?.meta?.dhash || null,
                objectUrl: objUrl
            };
            imageMetaCache.set(cacheKey, { lastModified, size: blob.size, meta });
            return meta;
        }

        try {
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('影像解碼失敗'));
                im.src = objUrl;
            });
            const w = headerInfo.width || img.naturalWidth || img.width || 0;
            const h = headerInfo.height || img.naturalHeight || img.height || 0;
            const dhash = computeCanvasDHash(img, YOLO_THRESHOLDS.dhash_size || 8);
            const meta = {
                width: w,
                height: h,
                aspect_ratio: h > 0 ? Number((w / h).toFixed(4)) : 0.0,
                has_exif_orientation: headerInfo.orientation !== 1,
                exif_orientation: headerInfo.orientation,
                timestamp: ts,
                timestamp_source: 'file_mtime',
                datetime_str: dtStr,
                read_error: null,
                dhash,
                objectUrl: objUrl
            };
            imageMetaCache.set(cacheKey, { lastModified, size: blob.size, meta });
            return meta;
        } catch (err) {
            try { URL.revokeObjectURL(objUrl); } catch (_) {}
            return {
                width: 0,
                height: 0,
                aspect_ratio: 0.0,
                has_exif_orientation: false,
                exif_orientation: 1,
                timestamp: ts,
                timestamp_source: 'file_mtime',
                datetime_str: dtStr,
                read_error: `無法讀取影像檔: ${err.message}`,
                dhash: new Uint8Array(0),
                objectUrl: ''
            };
        }
    }

    // ========================================================================
    // 3. IndexedDB 儲存最近一次資料夾 Handle（支援重新整理後一鍵恢復）
    // ========================================================================
    const IDB_NAME = 'yolo_web_fs_db';
    const IDB_STORE = 'handles';

    function openHandlesDb() {
        return new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') return reject(new Error('No IndexedDB'));
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function saveRecentHandleToIdb(key, handle) {
        try {
            const db = await openHandlesDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(handle, key);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) {}
    }

    async function loadRecentHandleFromIdb(key) {
        try {
            const db = await openHandlesDb();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const r = tx.objectStore(IDB_STORE).get(key);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
        } catch (_) {
            return null;
        }
    }

    // ========================================================================
    // 4. 資料夾存取供應器：NativeFsProvider (本機真實資料夾) 與 MemoryFsProvider (內建範例)
    // ========================================================================
    function decodeBytesWithFallback(uint8) {
        try {
            const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(uint8);
            return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
        } catch (_) {
            try {
                const big5 = new TextDecoder('big5', { fatal: true }).decode(uint8);
                return { text: big5, encoding: 'cp950' };
            } catch (e) {
                throw new Error('檔案編碼無法解析為 UTF-8 或 Big5');
            }
        }
    }

    class NativeFsProvider {
        constructor(dirHandle, virtualPath) {
            this.dirHandle = dirHandle;
            this.virtualPath = virtualPath;
            this.name = dirHandle.name;
            this.isMemory = false;
        }

        async listFiles() {
            const out = [];
            for await (const [name, handle] of this.dirHandle.entries()) {
                if (handle.kind === 'file') {
                    out.push({ name, handle });
                }
            }
            out.sort((a, b) => a.name.localeCompare(b.name));
            return out;
        }

        async fileExists(filename) {
            try {
                await this.dirHandle.getFileHandle(filename, { create: false });
                return true;
            } catch (_) {
                return false;
            }
        }

        async readTextFile(filename) {
            const fh = await this.dirHandle.getFileHandle(filename, { create: false });
            const file = await fh.getFile();
            const buf = await file.arrayBuffer();
            const decoded = decodeBytesWithFallback(new Uint8Array(buf));
            return {
                ...decoded,
                size: file.size,
                lastModified: file.lastModified
            };
        }

        async writeTextFile(filename, content) {
            const fh = await this.dirHandle.getFileHandle(filename, { create: true });
            const writable = await fh.createWritable();
            await writable.write(content);
            await writable.close();
        }

        async removeFile(filename) {
            try {
                await this.dirHandle.removeEntry(filename);
            } catch (_) {}
        }

        async getImageEntry(filename, options = {}) {
            const fh = await this.dirHandle.getFileHandle(filename, { create: false });
            const file = await fh.getFile();
            const cacheKey = `${this.virtualPath}/${filename}`;
            const meta = await inspectImageBlob(cacheKey, file, file.lastModified, options);
            return meta;
        }

        async getMetaSubdir(create = true) {
            return await this.dirHandle.getDirectoryHandle('_yolo_batch_workspace', { create });
        }

        async readWorkspaceJson(relName, fallbackObj) {
            try {
                const metaDir = await this.getMetaSubdir(false);
                const fh = await metaDir.getFileHandle(relName, { create: false });
                const file = await fh.getFile();
                const txt = await file.text();
                return { ...fallbackObj, ...JSON.parse(txt) };
            } catch (_) {
                return JSON.parse(JSON.stringify(fallbackObj));
            }
        }

        async writeWorkspaceJson(relName, dataObj) {
            try {
                const metaDir = await this.getMetaSubdir(true);
                const fh = await metaDir.getFileHandle(relName, { create: true });
                const writable = await fh.createWritable();
                await writable.write(JSON.stringify(dataObj, null, 2));
                await writable.close();
            } catch (_) {}
        }

        async writeBackupSnapshot(backupId, snapshotObj) {
            try {
                const metaDir = await this.getMetaSubdir(true);
                const backupsDir = await metaDir.getDirectoryHandle('backups', { create: true });
                const bDir = await backupsDir.getDirectoryHandle(backupId, { create: true });
                const fh = await bDir.getFileHandle('manifest.json', { create: true });
                const writable = await fh.createWritable();
                await writable.write(JSON.stringify(snapshotObj, null, 2));
                await writable.close();
            } catch (_) {}
        }

        async readBackupSnapshot(backupId) {
            try {
                const metaDir = await this.getMetaSubdir(false);
                const backupsDir = await metaDir.getDirectoryHandle('backups', { create: false });
                const bDir = await backupsDir.getDirectoryHandle(backupId, { create: false });
                const fh = await bDir.getFileHandle('manifest.json', { create: false });
                const file = await fh.getFile();
                return JSON.parse(await file.text());
            } catch (_) {
                return null;
            }
        }

        async removeBackupSnapshot(backupId) {
            try {
                const metaDir = await this.getMetaSubdir(false);
                const backupsDir = await metaDir.getDirectoryHandle('backups', { create: false });
                await backupsDir.removeEntry(backupId, { recursive: true });
            } catch (_) {}
        }

        async listBackupIds() {
            const ids = [];
            try {
                const metaDir = await this.getMetaSubdir(false);
                const backupsDir = await metaDir.getDirectoryHandle('backups', { create: false });
                for await (const [name, handle] of backupsDir.entries()) {
                    if (handle.kind === 'directory') ids.push(name);
                }
            } catch (_) {}
            ids.sort();
            return ids;
        }
    }

    class MemoryFsProvider {
        constructor(virtualPath, name) {
            this.virtualPath = virtualPath;
            this.name = name;
            this.isMemory = true;
            this.textFiles = new Map();  // filename -> { content, lastModified }
            this.imageBlobs = new Map(); // filename -> { blob, lastModified }
            this.workspaceJson = new Map();
            this.backups = new Map();
        }

        async listFiles() {
            const names = new Set([...this.textFiles.keys(), ...this.imageBlobs.keys()]);
            return Array.from(names).sort().map(name => ({ name, handle: null }));
        }

        async fileExists(filename) {
            return this.textFiles.has(filename) || this.imageBlobs.has(filename);
        }

        async readTextFile(filename) {
            if (!this.textFiles.has(filename)) throw new Error(`File not found: ${filename}`);
            const entry = this.textFiles.get(filename);
            return {
                text: entry.content,
                encoding: 'utf-8',
                size: new Blob([entry.content]).size,
                lastModified: entry.lastModified
            };
        }

        async writeTextFile(filename, content) {
            this.textFiles.set(filename, { content: String(content), lastModified: Date.now() });
        }

        async removeFile(filename) {
            this.textFiles.delete(filename);
            this.imageBlobs.delete(filename);
        }

        async getImageEntry(filename, options = {}) {
            if (!this.imageBlobs.has(filename)) throw new Error(`Image not found: ${filename}`);
            const entry = this.imageBlobs.get(filename);
            const cacheKey = `${this.virtualPath}/${filename}`;
            return await inspectImageBlob(cacheKey, entry.blob, entry.lastModified, options);
        }

        async readWorkspaceJson(relName, fallbackObj) {
            if (!this.workspaceJson.has(relName)) {
                return JSON.parse(JSON.stringify(fallbackObj));
            }
            return { ...fallbackObj, ...JSON.parse(JSON.stringify(this.workspaceJson.get(relName))) };
        }

        async writeWorkspaceJson(relName, dataObj) {
            this.workspaceJson.set(relName, JSON.parse(JSON.stringify(dataObj)));
        }

        async writeBackupSnapshot(backupId, snapshotObj) {
            this.backups.set(backupId, JSON.parse(JSON.stringify(snapshotObj)));
        }

        async readBackupSnapshot(backupId) {
            return this.backups.get(backupId) || null;
        }

        async removeBackupSnapshot(backupId) {
            this.backups.delete(backupId);
        }

        async listBackupIds() {
            return Array.from(this.backups.keys()).sort();
        }
    }

    // 產生與 app.py ensure_sample_dataset() 1:1 相同的內建範例資料集
    async function buildSampleMemoryProvider() {
        const vPath = '[內建練習範例] sample_dataset';
        const provider = new MemoryFsProvider(vPath, 'sample_dataset');

        await provider.writeTextFile('classes.txt', 'helmet\nvest\nperson\nforklift\n');

        async function makeSceneBlob(bgColor, shapes, width = 640, height = 480) {
            const c = document.createElement('canvas');
            c.width = width;
            c.height = height;
            const ctx = c.getContext('2d');
            ctx.fillStyle = `rgb(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]})`;
            ctx.fillRect(0, 0, width, height);
            ctx.strokeStyle = `rgb(${bgColor[0] + 12}, ${bgColor[1] + 12}, ${bgColor[2] + 12})`;
            ctx.lineWidth = 1;
            for (let gx = 0; gx < width; gx += 80) {
                ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, height); ctx.stroke();
            }
            for (let gy = 0; gy < height; gy += 80) {
                ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
            }
            for (const [kind, box, fillC, outlineC] of shapes) {
                const [x1, y1, x2, y2] = box;
                ctx.fillStyle = `rgb(${fillC[0]}, ${fillC[1]}, ${fillC[2]})`;
                ctx.strokeStyle = `rgb(${outlineC[0]}, ${outlineC[1]}, ${outlineC[2]})`;
                ctx.lineWidth = 3;
                if (kind === 'rect') {
                    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                } else if (kind === 'ellipse') {
                    const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2;
                    const rx = (x2 - x1) / 2, ry = (y2 - y1) / 2;
                    ctx.beginPath();
                    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                }
            }
            return await new Promise(resolve => c.toBlob(resolve, 'image/jpeg', 0.92));
        }

        const now = Date.now();
        const camADeltas = [0, 6, 12, -5];
        for (let idx = 1; idx <= 4; idx++) {
            const dx = camADeltas[idx - 1];
            const blob = await makeSceneBlob([38, 46, 58], [
                ['rect', [160 + dx, 140, 280 + dx, 410], [55, 95, 160], [220, 235, 255]],
                ['ellipse', [185 + dx, 95, 255 + dx, 150], [245, 190, 30], [255, 240, 150]],
                ['rect', [170 + dx, 185, 270 + dx, 310], [235, 110, 25], [255, 220, 120]]
            ]);
            provider.imageBlobs.set(`CamA_00${idx}.jpg`, { blob, lastModified: now + idx * 1000 });
        }
        await provider.writeTextFile(
            'CamA_001.txt',
            '0 0.343750 0.255208 0.109375 0.114583\n' +
            '1 0.343750 0.515625 0.156250 0.260417\n' +
            '2 0.343750 0.572917 0.187500 0.562500\n'
        );

        const camBDeltas = [0, 8, 14];
        for (let idx = 1; idx <= 3; idx++) {
            const dx = camBDeltas[idx - 1];
            const h = idx < 3 ? 480 : 360;
            const blob = await makeSceneBlob([48, 42, 38], [
                ['rect', [310 + dx, 150, 540 + dx, 340], [210, 145, 20], [255, 220, 110]],
                ['ellipse', [390 + dx, 110, 445 + dx, 160], [240, 200, 40], [255, 250, 180]]
            ], 640, h);
            provider.imageBlobs.set(`CamB_00${idx}.jpg`, { blob, lastModified: now + (10 + idx) * 1000 });
        }
        await provider.writeTextFile(
            'CamB_001.txt',
            '3 0.664062 0.510417 0.359375 0.395833\n' +
            '0 0.652344 0.281250 0.085938 0.104167\n'
        );

        const anom1Blob = await makeSceneBlob([52, 36, 44], [
            ['rect', [120, 120, 260, 320], [140, 70, 90], [255, 180, 190]]
        ]);
        provider.imageBlobs.set('Check_Anomaly_01.jpg', { blob: anom1Blob, lastModified: now + 20000 });
        await provider.writeTextFile(
            'Check_Anomaly_01.txt',
            '2 0.296875 0.458333 0.218750 0.416667\n' +
            '2 0.298000 0.459000 0.218000 0.415000\n' +
            '9 0.750000 0.500000 0.200000 0.300000\n' +
            '0 0.920000 0.500000 0.280000 0.250000\n'
        );

        const anom2Blob = await makeSceneBlob([40, 50, 45], []);
        provider.imageBlobs.set('Check_EmptyLabel_02.jpg', { blob: anom2Blob, lastModified: now + 25000 });
        await provider.writeTextFile('Check_EmptyLabel_02.txt', '');

        await provider.writeTextFile('Orphan_Old_99.txt', '0 0.500000 0.500000 0.200000 0.200000\n');
        return provider;
    }

    // ========================================================================
    // 5. 綁定的資料夾與檔案 Handle 狀態表
    // ========================================================================
    const dirProviders = new Map(); // virtualPath -> NativeFsProvider | MemoryFsProvider
    const customClassesFileHandles = new Map(); // virtualFilePath -> { name, handle }

    let activeState = {
        workspaceId: '',
        imageProvider: null,
        labelProvider: null,
        classesPath: '',
        imageUrlByStem: new Map()
    };

    async function registerDirectoryHandle(dirHandle) {
        for (const [vPath, prov] of dirProviders.entries()) {
            if (!prov.isMemory && prov.dirHandle && typeof prov.dirHandle.isSameEntry === 'function') {
                try {
                    if (await prov.dirHandle.isSameEntry(dirHandle)) {
                        return vPath;
                    }
                } catch (_) {}
            }
        }
        let vPath = `[本機資料夾] ${dirHandle.name}`;
        let suffix = 2;
        while (dirProviders.has(vPath)) {
            vPath = `[本機資料夾] ${dirHandle.name} (#${suffix++})`;
        }
        dirProviders.set(vPath, new NativeFsProvider(dirHandle, vPath));
        return vPath;
    }

    // ========================================================================
    // 6. 1:1 移植 core/scanner.py
    // ========================================================================
    async function parseClassesFromProvider(labelProvider, imageProvider, explicitClassesPath) {
        const candidateFiles = [];
        const seen = new Set();
        for (const prov of [labelProvider, imageProvider]) {
            if (!prov) continue;
            const entries = await prov.listFiles();
            for (const e of entries) {
                if (RESERVED_CLASS_FILENAMES.has(e.name.toLowerCase())) {
                    const p = `${prov.virtualPath}/${e.name}`;
                    if (!seen.has(p)) {
                        seen.add(p);
                        candidateFiles.push(p);
                    }
                }
            }
        }

        let resolvedPath = explicitClassesPath || '';
        let fileData = null;
        let filename = 'classes.txt';

        if (resolvedPath && customClassesFileHandles.has(resolvedPath)) {
            const custom = customClassesFileHandles.get(resolvedPath);
            filename = custom.name;
            try {
                const file = await custom.handle.getFile();
                const buf = await file.arrayBuffer();
                fileData = decodeBytesWithFallback(new Uint8Array(buf));
            } catch (err) {
                fileData = { error: err.message };
            }
        } else {
            if (resolvedPath) {
                const parts = resolvedPath.split('/');
                filename = parts[parts.length - 1] || 'classes.txt';
            } else if (candidateFiles.length > 0) {
                resolvedPath = candidateFiles[0];
                const parts = resolvedPath.split('/');
                filename = parts[parts.length - 1] || 'classes.txt';
            } else {
                resolvedPath = `${labelProvider.virtualPath}/classes.txt`;
                filename = 'classes.txt';
            }

            for (const prov of [labelProvider, imageProvider]) {
                if (!prov) continue;
                if (await prov.fileExists(filename)) {
                    try {
                        fileData = await prov.readTextFile(filename);
                        resolvedPath = `${prov.virtualPath}/${filename}`;
                    } catch (err) {
                        fileData = { error: err.message };
                    }
                    break;
                }
            }
        }

        const result = {
            exists: false,
            path: resolvedPath,
            filename,
            classes: [],
            class_map: {},
            candidate_files: candidateFiles,
            issues: [],
            status: 'pass'
        };

        if (!fileData) {
            result.status = 'warning';
            result.issues.push({
                level: 'warning',
                code: 'MISSING_CLASSES_FILE',
                blocking: false,
                reason: '尚未找到 classes.txt 類別定義檔',
                suggestion: '仍可檢視標記框與編號，但無法顯示類別名稱與驗證編號上限；可於進階設定指定類別檔。'
            });
            return result;
        }

        result.exists = true;
        if (fileData.error) {
            result.status = 'error';
            result.issues.push({
                level: 'error',
                code: 'CLASSES_READ_ERR',
                blocking: true,
                reason: `讀取 classes.txt 失敗: ${fileData.error}`,
                suggestion: '請將 classes.txt 另存為 UTF-8 格式後重新載入。'
            });
            return result;
        }

        if (fileData.encoding === 'cp950') {
            result.status = 'warning';
            result.issues.push({
                level: 'warning',
                code: 'CLASSES_ENCODING_WARN',
                blocking: false,
                reason: 'classes.txt 編碼為 ANSI/Big5 而非 UTF-8',
                suggestion: '建議於類別修正儲存時自動轉為標準 UTF-8 編碼。'
            });
        }

        const rawLines = fileData.text.split(/\r?\n/);
        while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === '') {
            rawLines.pop();
        }

        const seenNames = {};
        rawLines.forEach((line, idx) => {
            const name = line.trim();
            if (name === '') {
                result.status = 'error';
                result.issues.push({
                    level: 'error',
                    code: 'CLASSES_EMPTY_LINE',
                    blocking: true,
                    reason: `classes.txt 第 ${idx + 1} 行（對應 ID ${idx}）為空白行`,
                    suggestion: '類別檔中間的空白行會導致後續類別編號順延錯位，請先透過「類別修正」清理。'
                });
            } else if (Object.prototype.hasOwnProperty.call(seenNames, name)) {
                if (result.status !== 'error') result.status = 'warning';
                result.issues.push({
                    level: 'warning',
                    code: 'CLASSES_DUP_NAME',
                    blocking: false,
                    reason: `類別名稱「${name}」重複出現於 ID ${seenNames[name]} 與 ID ${idx}`,
                    suggestion: '可使用上方「類別修正」工具將重複的類別編號合併。'
                });
            } else {
                seenNames[name] = idx;
            }
            result.classes.push({ id: idx, name });
            result.class_map[idx] = name;
        });

        if (result.classes.length === 0) {
            result.status = 'warning';
            result.issues.push({
                level: 'warning',
                code: 'CLASSES_EMPTY',
                blocking: false,
                reason: 'classes.txt 內容為空（尚無任何類別定義）',
                suggestion: '請確認是否選對類別檔，或於畫布新增標記框時建立新類別。'
            });
        }

        return result;
    }

    function parseAndValidateYoloTxtContent(rawText, classMap, hasClassesFile) {
        const boxes = [];
        const issues = [];
        const rawLinesOut = [];

        const lines = String(rawText).replace(/^\uFEFF/, '').split(/\r?\n/);
        const nonEmptyLines = lines.filter(l => l.trim() !== '');
        if (nonEmptyLines.length === 0) {
            issues.push({
                level: 'warning',
                code: 'EMPTY_LABEL',
                blocking: false,
                reason: '標記檔存在但內容為空（0 個標記框）',
                suggestion: '若此照片確實沒有目標物件（背景圖），可於檢查頁點擊「確認為無物件照片」；若為漏標記則可套用參考照片。'
            });
            return {
                boxes: [],
                raw_lines: [],
                is_empty_file: true,
                has_blocking_error: false,
                format_status: 'empty_file',
                format_label: '空白標記檔 (0 框)',
                issues,
                status: 'warning'
            };
        }

        let hasFormatErr = false;
        let hasUndefClass = false;
        let hasCoordErr = false;

        lines.forEach((rawLine, lineIdx) => {
            const lineNum = lineIdx + 1;
            const stripped = rawLine.trim();
            if (!stripped) return;

            const parts = stripped.split(/\s+/);
            rawLinesOut.push(stripped);

            if (parts.length !== 5) {
                hasFormatErr = true;
                issues.push({
                    level: 'error',
                    code: 'FORMAT_ERR',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行欄位數量錯誤：應為 5 欄，實際為 ${parts.length} 欄`,
                    suggestion: '請於檢查與微調畫布重新調整並儲存此標記檔。'
                });
                return;
            }

            if (parts[0].includes('.') || !/^-?\d+$/.test(parts[0])) {
                hasFormatErr = true;
                issues.push({
                    level: 'error',
                    code: 'CLASS_ID_NOT_INT',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行類別編號 \`${parts[0]}\` 不是有效整數`,
                    suggestion: 'YOLO 第一欄必須為非負整數類別編號。'
                });
                return;
            }
            const classId = parseInt(parts[0], 10);

            const xc = Number(parts[1]);
            const yc = Number(parts[2]);
            const w = Number(parts[3]);
            const h = Number(parts[4]);
            if ([xc, yc, w, h].some(v => Number.isNaN(v))) {
                hasFormatErr = true;
                issues.push({
                    level: 'error',
                    code: 'COORD_NOT_FLOAT',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行座標無法解析為數值`,
                    suggestion: '請檢查標記檔座標欄位是否包含非數字字元。'
                });
                return;
            }
            if (![xc, yc, w, h].every(v => Number.isFinite(v))) {
                hasFormatErr = true;
                issues.push({
                    level: 'error',
                    code: 'NON_FINITE_COORD',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行座標含 NaN 或 Infinity`,
                    suggestion: '請改為有限數值。'
                });
                return;
            }

            const hasClassInMap = Object.prototype.hasOwnProperty.call(classMap, classId);
            const className = hasClassInMap ? classMap[classId] : `未定義類別(${classId})`;

            if (classId < 0) {
                hasUndefClass = true;
                issues.push({
                    level: 'error',
                    code: 'CLASS_OUT_OF_RANGE',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行類別編號 \`${classId}\` 為負數`,
                    suggestion: '請使用「類別修正」工具將此編號改為有效類別。'
                });
            } else if (hasClassesFile && !hasClassInMap) {
                hasUndefClass = true;
                const maxCid = Math.max(0, Object.keys(classMap).length - 1);
                issues.push({
                    level: 'error',
                    code: 'CLASS_OUT_OF_RANGE',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行類別編號 \`${classId}\` 不在 classes.txt 定義範圍內 (0~${maxCid})`,
                    suggestion: '請使用上方「類別修正」工具重新對應此類別編號，或確認是否選錯 classes.txt。'
                });
            }

            if (w <= 0 || h <= 0) {
                hasCoordErr = true;
                issues.push({
                    level: 'error',
                    code: 'ZERO_OR_NEG_SIZE',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行 (${className}) 標記框寬度或高度為 0 或負數`,
                    suggestion: '請於檢查頁選取此框按 Delete 刪除，或拉動控制點修正尺寸。'
                });
            } else if (w < YOLO_THRESHOLDS.tiny_box_min_dim || h < YOLO_THRESHOLDS.tiny_box_min_dim) {
                hasCoordErr = true;
                issues.push({
                    level: 'warning',
                    code: 'TINY_BOX',
                    blocking: false,
                    line: lineNum,
                    reason: `第 ${lineNum} 行 (${className}) 標記框尺寸極小 (${w.toFixed(4)}×${h.toFixed(4)})，疑似滑鼠誤點`,
                    suggestion: '請於畫布檢查是否為誤點產生的極小框，必要時按 Delete 刪除。'
                });
            } else if (w > YOLO_THRESHOLDS.oversize_box_max_dim || h > YOLO_THRESHOLDS.oversize_box_max_dim) {
                hasCoordErr = true;
                issues.push({
                    level: 'error',
                    code: 'OVERSIZE_BOX',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行 (${className}) 標記框寬高超過 1.0 (${w.toFixed(4)}×${h.toFixed(4)})`,
                    suggestion: '座標未正確正規化，請於畫布拉動控制點縮放進影像範圍內。'
                });
            }

            const xmin = xc - w / 2.0;
            const ymin = yc - h / 2.0;
            const xmax = xc + w / 2.0;
            const ymax = yc + h / 2.0;
            const tol = YOLO_THRESHOLDS.edge_out_of_bounds_tol;

            if (xc < 0.0 || xc > 1.0 || yc < 0.0 || yc > 1.0) {
                hasCoordErr = true;
                issues.push({
                    level: 'error',
                    code: 'CENTER_OUT_OF_BOUNDS',
                    blocking: true,
                    line: lineNum,
                    reason: `第 ${lineNum} 行 (${className}) 中心點超出 [0, 1] 範圍 (x=${xc.toFixed(3)}, y=${yc.toFixed(3)})`,
                    suggestion: '請於畫布將標記框拖回影像範圍內或刪除。'
                });
            } else if (xmin < -tol || ymin < -tol || xmax > 1.0 + tol || ymax > 1.0 + tol) {
                hasCoordErr = true;
                issues.push({
                    level: 'warning',
                    code: 'EDGE_OUT_OF_BOUNDS',
                    blocking: false,
                    line: lineNum,
                    reason: `第 ${lineNum} 行 (${className}) 標記框邊緣略微超出影像邊界`,
                    suggestion: '可在檢查與微調畫布直接微調框邊界，確認即可自動裁切至 [0, 1]。'
                });
            }

            boxes.push({
                line: lineNum,
                class_id: classId,
                class_name: className,
                x_center: xc,
                y_center: yc,
                width: w,
                height: h,
                xc,
                yc,
                w,
                h,
                raw: stripped
            });
        });

        for (let i = 0; i < boxes.length; i++) {
            for (let j = i + 1; j < boxes.length; j++) {
                const iou = computeIoU(boxes[i], boxes[j]);
                if (iou >= YOLO_THRESHOLDS.duplicate_box_iou) {
                    hasCoordErr = true;
                    const sameCls = boxes[i].class_id === boxes[j].class_id;
                    const clsDesc = sameCls
                        ? `同類別 (${boxes[i].class_name})`
                        : `跨類別 (${boxes[i].class_name} 與 ${boxes[j].class_name})`;
                    issues.push({
                        level: 'warning',
                        code: 'DUPLICATE_BOX',
                        blocking: false,
                        line: boxes[j].line,
                        reason: `第 ${boxes[i].line} 行與第 ${boxes[j].line} 行框高度重疊（${clsDesc}，重疊率 ${Math.round(iou * 100)}%）`,
                        suggestion: '請於畫布點選多餘的重疊框，按 Delete 鍵即可刪除。'
                    });
                }
            }
        }

        const hasBlocking = issues.some(i => i.blocking);
        const hasWarning = issues.some(i => i.level === 'warning');
        const status = hasBlocking ? 'error' : (hasWarning ? 'warning' : 'pass');

        let formatStatus = 'valid';
        let formatLabel = '格式檢查正常';
        if (hasFormatErr) {
            formatStatus = 'format_error';
            formatLabel = '格式錯誤';
        } else if (hasUndefClass) {
            formatStatus = 'class_undefined';
            formatLabel = '類別未定義';
        } else if (hasCoordErr) {
            formatStatus = 'coord_abnormal';
            formatLabel = '座標或尺寸異常';
        }

        return {
            boxes,
            raw_lines: rawLinesOut,
            is_empty_file: false,
            has_blocking_error: hasBlocking,
            format_status: formatStatus,
            format_label: formatLabel,
            issues,
            status
        };
    }

    async function loadProjectState(labelProvider) {
        const defaultState = {
            item_records: {},
            saved_master_groups: [],
            review_queue: [],
            last_active_stem: null,
            last_master_stem: null,
            last_filter: 'all',
            last_backup_id: null,
            last_batch_stats: null,
            audit_logs: []
        };
        return await labelProvider.readWorkspaceJson('project_state.json', defaultState);
    }

    async function saveProjectState(labelProvider, state) {
        await labelProvider.writeWorkspaceJson('project_state.json', state);
    }

    async function appendAuditLog(labelProvider, entry) {
        entry.timestamp = nowStr();
        const state = await loadProjectState(labelProvider);
        const logs = Array.isArray(state.audit_logs) ? state.audit_logs : [];
        logs.unshift(entry);
        state.audit_logs = logs.slice(0, 100);
        if (entry.backup_id) {
            state.last_backup_id = entry.backup_id;
        }
        await saveProjectState(labelProvider, state);
    }

    function formatAuditLogs(state) {
        return (state.audit_logs || []).slice(0, 30).map(log => ({
            title: log.title || log.op_type || '系統操作',
            timestamp: log.timestamp || '',
            detail: log.detail || (
                'pending_refine_count' in log
                    ? `待處理照片：${log.pending_refine_count} 張`
                    : `備份編號：${log.backup_id || '-'}`
            )
        }));
    }

    async function performFullScan() {
        const imageProvider = activeState.imageProvider;
        const labelProvider = activeState.labelProvider || imageProvider;
        if (!imageProvider) {
            return { ok: false, error: '請先選擇照片資料夾。' };
        }

        const state = await loadProjectState(labelProvider);
        const classesInfo = await parseClassesFromProvider(labelProvider, imageProvider, activeState.classesPath);
        activeState.classesPath = classesInfo.path;
        const classMap = classesInfo.class_map;
        const hasClassesFile = classesInfo.exists && Object.keys(classMap).length > 0;
        const classesBasename = (classesInfo.filename || 'classes.txt').toLowerCase();

        const imgEntries = await imageProvider.listFiles();
        const imagesByStem = new Map();
        for (const entry of imgEntries) {
            const [stem, ext] = splitExt(entry.name);
            if (SUPPORTED_IMAGE_EXTS.has(ext.toLowerCase())) {
                if (!imagesByStem.has(stem)) imagesByStem.set(stem, []);
                imagesByStem.get(stem).push(entry.name);
            }
        }

        const lblEntries = await labelProvider.listFiles();
        const labelsByStem = new Map();
        for (const entry of lblEntries) {
            const lower = entry.name.toLowerCase();
            if (RESERVED_CLASS_FILENAMES.has(lower) || lower === classesBasename) continue;
            const [stem, ext] = splitExt(entry.name);
            if (ext.toLowerCase() === '.txt') {
                if (!labelsByStem.has(stem)) labelsByStem.set(stem, []);
                labelsByStem.get(stem).push(entry.name);
            }
        }

        const allStems = Array.from(new Set([...imagesByStem.keys(), ...labelsByStem.keys()])).sort();
        const items = [];
        const savedItemMeta = state.item_records || {};

        const summary = {
            total_items: 0,
            photo_count: 0,
            label_file_count: 0,
            total_box_count: 0,
            total_issue_count: 0,
            paired_count: 0,
            paired_with_boxes_count: 0,
            empty_label_count: 0,
            unlabeled_count: 0,
            orphan_label_count: 0,
            ambiguous_count: 0,
            reference_candidate_count: 0,
            format_valid_count: 0,
            format_warning_count: 0,
            format_error_count: 0,
            status_pass: 0,
            status_warning: 0,
            status_error: 0,
            review_unlabeled_count: 0,
            review_pending_count: 0,
            review_needs_fix_count: 0,
            review_confirmed_count: 0,
            needs_refinement_count: 0
        };

        const issueGroupsMap = new Map();
        function registerIssueGroup(code, title, level, actionType, actionLabel, stem, description = '') {
            if (!issueGroupsMap.has(code)) {
                issueGroupsMap.set(code, {
                    code,
                    title,
                    description: description || title,
                    level,
                    action_type: actionType,
                    action_label: actionLabel,
                    stems: [],
                    count: 0
                });
            }
            const grp = issueGroupsMap.get(code);
            if (!grp.stems.includes(stem)) {
                grp.stems.push(stem);
                grp.count = grp.stems.length;
            }
        }

        const classUsageStats = {};
        for (const [cidStr, cname] of Object.entries(classMap)) {
            const cid = Number(cidStr);
            classUsageStats[cid] = { id: cid, name: cname, file_count: 0, box_count: 0, undefined: false };
        }

        activeState.imageUrlByStem.clear();

        let processedIdx = 0;
        const totalStems = allStems.length;
        for (const stem of allStems) {
            processedIdx += 1;
            if (processedIdx % 40 === 0) {
                const statusEl = typeof document !== 'undefined' ? document.getElementById('workspaceLoadStatus') : null;
                if (statusEl && !statusEl.hidden) {
                    statusEl.textContent = `正在掃描照片與標記檔 (${processedIdx} / ${totalStems})…`;
                }
                await yieldToMainThread();
            }
            const imgList = imagesByStem.get(stem) || [];
            const lblList = labelsByStem.get(stem) || [];
            const rec = savedItemMeta[stem] || {};

            // 情況 1：重複主檔名衝突
            if (imgList.length > 1) {
                const imgMeta = await imageProvider.getImageEntry(imgList[0]);
                if (imgMeta.objectUrl) activeState.imageUrlByStem.set(stem, imgMeta.objectUrl);
                const issues = [{
                    level: 'error',
                    code: 'DUPLICATE_STEM',
                    blocking: true,
                    reason: `同主檔名存在多個不同副檔名照片：${imgList.join(', ')}`,
                    suggestion: 'YOLO 標記檔依主檔名配對，請於資料夾移除或重新命名重複照片。'
                }];
                registerIssueGroup('DUPLICATE_STEM', '重複主檔名衝突', 'error', 'studio_error', '檢視衝突檔案', stem);
                items.push({
                    stem,
                    image_name: imgList.join(' / '),
                    image_path: `${imageProvider.virtualPath}/${imgList[0]}`,
                    label_name: lblList[0] || '',
                    label_path: lblList[0] ? `${labelProvider.virtualPath}/${lblList[0]}` : '',
                    pair_type: 'ambiguous',
                    pair_label: '重複主檔名衝突',
                    format_status: 'format_error',
                    format_label: '檔名衝突',
                    review_status: 'needs_fix',
                    review_label: '需修正',
                    review_state: 'needs_refinement',
                    has_blocking_error: true,
                    is_empty_file: false,
                    status: 'error',
                    box_count: 0,
                    boxes: [],
                    width: imgMeta.width,
                    height: imgMeta.height,
                    aspect_ratio: imgMeta.aspect_ratio,
                    timestamp: imgMeta.timestamp,
                    timestamp_source: imgMeta.timestamp_source,
                    datetime_str: imgMeta.datetime_str,
                    master_source: rec.master_source || '',
                    content_hash: '',
                    issues,
                    has_image: true,
                    has_label: lblList.length > 0
                });
                summary.photo_count += 1;
                summary.ambiguous_count += 1;
                summary.format_error_count += 1;
                summary.status_error += 1;
                summary.review_needs_fix_count += 1;
                summary.total_issue_count += issues.length;
                continue;
            }

            // 情況 2：孤立標記檔
            if (imgList.length === 0 && lblList.length > 0) {
                const lblName = lblList[0];
                const lblData = await labelProvider.readTextFile(lblName);
                const parsed = parseAndValidateYoloTxtContent(lblData.text, classMap, hasClassesFile);
                const issues = [{
                    level: 'warning',
                    code: 'ORPHAN_LABEL',
                    blocking: false,
                    reason: `找不到與 \`${lblName}\` 同主檔名的照片`,
                    suggestion: '請確認對應照片是否遺漏，或此為多餘的舊標記檔。'
                }, ...parsed.issues];
                registerIssueGroup('ORPHAN_LABEL', '找不到對應照片的孤立標記檔', 'warning', 'studio_orphan', '檢視孤立標記檔', stem);
                const hasErr = issues.some(i => i.blocking);
                const status = hasErr ? 'error' : 'warning';
                items.push({
                    stem,
                    image_name: '(無對應照片)',
                    image_path: '',
                    label_name: lblName,
                    label_path: `${labelProvider.virtualPath}/${lblName}`,
                    pair_type: 'orphan_label',
                    pair_label: '孤立標記檔',
                    format_status: 'orphan_label',
                    format_label: '缺少對應照片',
                    review_status: 'needs_fix',
                    review_label: '需修正',
                    review_state: 'needs_refinement',
                    has_blocking_error: hasErr,
                    is_empty_file: parsed.is_empty_file,
                    status,
                    box_count: parsed.boxes.length,
                    boxes: parsed.boxes,
                    width: 0,
                    height: 0,
                    aspect_ratio: 0.0,
                    timestamp: (lblData.lastModified || Date.now()) / 1000.0,
                    datetime_str: nowStr(),
                    master_source: rec.master_source || '',
                    content_hash: computeNormalizedContentHash(lblData.text),
                    issues,
                    has_image: false,
                    has_label: true
                });
                summary.label_file_count += 1;
                summary.orphan_label_count += 1;
                summary.total_box_count += parsed.boxes.length;
                summary.total_issue_count += issues.length;
                if (status === 'error') {
                    summary.format_error_count += 1;
                    summary.status_error += 1;
                } else {
                    summary.format_warning_count += 1;
                    summary.status_warning += 1;
                }
                continue;
            }

            // 情況 3：缺少標記檔的照片
            const imgName = imgList[0];
            const imgMeta = await imageProvider.getImageEntry(imgName);
            if (imgMeta.objectUrl) activeState.imageUrlByStem.set(stem, imgMeta.objectUrl);
            summary.photo_count += 1;

            if (lblList.length === 0) {
                const issues = [{
                    level: 'warning',
                    code: 'MISSING_LABEL',
                    blocking: false,
                    reason: '尚未建立標記檔 (.txt)',
                    suggestion: '可於「2. 批次套用」選取參考照片建立標記草稿，或於檢查頁確認為無物件照片。'
                }];
                registerIssueGroup('MISSING_LABEL', '缺少標記檔（尚未標記的照片）', 'info', 'batch_apply', '前往批次套用', stem);

                let hasBlocking = false;
                let fmtStatus = 'missing_label';
                let fmtLabel = '缺少標記檔';
                if (imgMeta.read_error) {
                    hasBlocking = true;
                    fmtStatus = 'read_error';
                    fmtLabel = '無法讀取';
                    issues.unshift({
                        level: 'error',
                        code: 'IMAGE_CORRUPT',
                        blocking: true,
                        reason: imgMeta.read_error,
                        suggestion: '照片檔案可能損毀，請檢查原始檔案。'
                    });
                    registerIssueGroup('IMAGE_CORRUPT', '照片無法讀取或損毀', 'error', 'studio_error', '檢視損毀檔案', stem);
                }

                const status = hasBlocking ? 'error' : 'warning';
                items.push({
                    stem,
                    image_name: imgName,
                    image_path: `${imageProvider.virtualPath}/${imgName}`,
                    label_name: '',
                    label_path: `${labelProvider.virtualPath}/${stem}.txt`,
                    pair_type: 'unlabeled',
                    pair_label: '未標記',
                    format_status: fmtStatus,
                    format_label: fmtLabel,
                    review_status: 'unlabeled',
                    review_label: '未標記',
                    review_state: '',
                    has_blocking_error: hasBlocking,
                    is_empty_file: false,
                    status,
                    box_count: 0,
                    boxes: [],
                    width: imgMeta.width,
                    height: imgMeta.height,
                    aspect_ratio: imgMeta.aspect_ratio,
                    timestamp: imgMeta.timestamp,
                    timestamp_source: imgMeta.timestamp_source,
                    datetime_str: imgMeta.datetime_str,
                    master_source: rec.master_source || '',
                    content_hash: '',
                    issues,
                    dhash: imgMeta.dhash,
                    has_image: !imgMeta.read_error,
                    has_label: false
                });
                summary.unlabeled_count += 1;
                summary.review_unlabeled_count += 1;
                summary.total_issue_count += issues.length;
                if (hasBlocking) {
                    summary.format_error_count += 1;
                    summary.status_error += 1;
                } else {
                    summary.format_warning_count += 1;
                    summary.status_warning += 1;
                }
                continue;
            }

            // 情況 4：已有標記檔的照片
            const lblName = lblList[0];
            summary.label_file_count += 1;
            summary.paired_count += 1;

            const lblData = await labelProvider.readTextFile(lblName);
            const parsed = parseAndValidateYoloTxtContent(lblData.text, classMap, hasClassesFile);
            const currentHash = computeNormalizedContentHash(lblData.text);
            let issues = [...parsed.issues];
            let hasBlocking = parsed.has_blocking_error;
            let fmtStatus = parsed.format_status;
            let fmtLabel = parsed.format_label;

            if (imgMeta.read_error) {
                hasBlocking = true;
                fmtStatus = 'read_error';
                fmtLabel = '無法讀取';
                issues.unshift({
                    level: 'error',
                    code: 'IMAGE_CORRUPT',
                    blocking: true,
                    reason: imgMeta.read_error,
                    suggestion: '照片檔案可能損毀，請檢查原始檔案。'
                });
            }
            if (imgMeta.has_exif_orientation) {
                issues.push({
                    level: 'warning',
                    code: 'EXIF_ROTATION',
                    blocking: false,
                    reason: `照片帶有 EXIF 旋轉標籤 (Orientation=${imgMeta.exif_orientation})`,
                    suggestion: '請於畫布確認標記框方向是否正確。'
                });
            }

            const savedReview = rec.review_state || '';
            const confirmedHash = rec.confirmed_hash || '';
            const masterSrc = rec.master_source || '';

            let reviewStatus = 'pending_review';
            let reviewLabel = '待人工確認';

            if (savedReview === 'confirmed' && confirmedHash && confirmedHash === currentHash && !hasBlocking) {
                reviewStatus = 'confirmed';
                reviewLabel = parsed.is_empty_file ? '已確認 (無物件)' : '已確認';
                if (parsed.is_empty_file) {
                    issues = issues.filter(i => i.code !== 'EMPTY_LABEL');
                    fmtStatus = 'valid';
                    fmtLabel = '格式檢查正常 (無物件)';
                }
            } else if (savedReview === 'needs_refinement' || hasBlocking) {
                reviewStatus = 'needs_fix';
                reviewLabel = '需修正';
            }

            for (const iss of issues) {
                const c = iss.code || 'OTHER';
                if (c === 'EMPTY_LABEL') {
                    registerIssueGroup(c, '空白標記檔（0 個標記框，可能為無物件照片或漏標）', 'warning', 'studio_empty', '逐張確認', stem);
                } else if (c === 'CLASS_OUT_OF_RANGE') {
                    registerIssueGroup(c, '類別編號未定義（超出 classes.txt 範圍）', 'error', 'class_remap', '開啟類別修正', stem);
                } else if (['FORMAT_ERR', 'CLASS_ID_NOT_INT', 'COORD_NOT_FLOAT', 'NON_FINITE_COORD', 'READ_FAIL'].includes(c)) {
                    registerIssueGroup('FORMAT_ERR', '標記檔格式或欄位錯誤', 'error', 'studio_error', '檢視錯誤檔案', stem);
                } else if (['ZERO_OR_NEG_SIZE', 'OVERSIZE_BOX', 'CENTER_OUT_OF_BOUNDS', 'EDGE_OUT_OF_BOUNDS', 'TINY_BOX'].includes(c)) {
                    registerIssueGroup('COORD_ABNORMAL', '標記框座標超出範圍或尺寸異常', iss.level, 'studio_coord', '進入畫布微調', stem);
                } else if (c === 'DUPLICATE_BOX') {
                    registerIssueGroup('DUPLICATE_BOX', '疑似重複疊加的標記框', 'warning', 'studio_dup', '進入畫布清理', stem);
                }
            }

            const seenCidsInFile = new Set();
            for (const b of parsed.boxes) {
                const cid = b.class_id;
                if (!classUsageStats[cid]) {
                    classUsageStats[cid] = {
                        id: cid,
                        name: classMap[cid] || `未定義類別(${cid})`,
                        file_count: 0,
                        box_count: 0,
                        undefined: true
                    };
                }
                classUsageStats[cid].box_count += 1;
                seenCidsInFile.add(cid);
            }
            for (const cid of seenCidsInFile) {
                classUsageStats[cid].file_count += 1;
            }

            if (parsed.is_empty_file) {
                summary.empty_label_count += 1;
            } else {
                summary.paired_with_boxes_count += 1;
            }

            const isValidReference = parsed.boxes.length > 0 && !hasBlocking;
            if (isValidReference) summary.reference_candidate_count += 1;

            const hasWarn = issues.some(i => i.level === 'warning');
            const overallStatus = hasBlocking ? 'error' : (hasWarn ? 'warning' : 'pass');

            if (hasBlocking) {
                summary.format_error_count += 1;
                summary.status_error += 1;
            } else if (hasWarn) {
                summary.format_warning_count += 1;
                summary.status_warning += 1;
            } else {
                summary.format_valid_count += 1;
                summary.status_pass += 1;
            }

            if (reviewStatus === 'confirmed') {
                summary.review_confirmed_count += 1;
            } else if (reviewStatus === 'needs_fix') {
                summary.review_needs_fix_count += 1;
                summary.needs_refinement_count += 1;
            } else {
                summary.review_pending_count += 1;
                summary.needs_refinement_count += 1;
            }

            summary.total_box_count += parsed.boxes.length;
            summary.total_issue_count += issues.length;

            const compatReviewState = reviewStatus === 'confirmed'
                ? 'confirmed'
                : (reviewStatus === 'needs_fix' ? 'needs_refinement' : (masterSrc ? 'unreviewed_copy' : ''));

            items.push({
                stem,
                image_name: imgName,
                image_path: `${imageProvider.virtualPath}/${imgName}`,
                label_name: lblName,
                label_path: `${labelProvider.virtualPath}/${lblName}`,
                pair_type: 'paired',
                pair_label: parsed.is_empty_file ? '空白標記檔 (0 框)' : '已配對',
                format_status: fmtStatus,
                format_label: fmtLabel,
                review_status: reviewStatus,
                review_label: reviewLabel,
                review_state: compatReviewState,
                has_blocking_error: hasBlocking,
                is_empty_file: parsed.is_empty_file,
                is_valid_reference: isValidReference,
                status: overallStatus,
                box_count: parsed.boxes.length,
                boxes: parsed.boxes,
                width: imgMeta.width,
                height: imgMeta.height,
                aspect_ratio: imgMeta.aspect_ratio,
                timestamp: imgMeta.timestamp,
                timestamp_source: imgMeta.timestamp_source,
                datetime_str: imgMeta.datetime_str,
                master_source: masterSrc,
                content_hash: currentHash,
                issues,
                dhash: imgMeta.dhash,
                has_image: !imgMeta.read_error,
                has_label: true
            });
        }

        summary.total_items = items.length;
        const photoCnt = summary.photo_count;
        summary.paired_pct = photoCnt > 0 ? Number(((summary.paired_count / photoCnt) * 100).toFixed(1)) : 0.0;
        summary.confirmed_pct = photoCnt > 0 ? Number(((summary.review_confirmed_count / photoCnt) * 100).toFixed(1)) : 0.0;
        summary.pending_review_count = summary.review_pending_count;
        summary.needs_fix_count = summary.review_needs_fix_count;
        summary.confirmed_count = summary.review_confirmed_count;

        const actionTypeMap = {
            batch_apply: 'go_batch_apply',
            class_remap: 'open_class_remap',
            studio_empty: 'review_group_items',
            studio_error: 'review_group_items',
            studio_coord: 'review_group_items',
            studio_dup: 'review_group_items',
            studio_orphan: 'review_group_items'
        };
        for (const grp of issueGroupsMap.values()) {
            grp.action_type = actionTypeMap[grp.action_type] || grp.action_type;
        }

        for (const it of items) {
            it.img_width = it.width || 0;
            it.img_height = it.height || 0;
            it.source_master = it.master_source || '';
            if (typeof it.is_valid_reference !== 'boolean') it.is_valid_reference = false;
            for (const iss of (it.issues || [])) {
                if (!iss.message) {
                    const reason = iss.reason || '';
                    const sugg = iss.suggestion || '';
                    iss.message = sugg ? `${reason}（${sugg}）` : reason;
                }
            }
        }

        const existingStems = new Set(items.map(i => i.stem));
        const validQueue = (state.review_queue || []).filter(st => existingStems.has(st));
        const lastActive = existingStems.has(state.last_active_stem) ? state.last_active_stem : null;
        const lastMaster = existingStems.has(state.last_master_stem) ? state.last_master_stem : null;

        let lastBackupObj = null;
        if (state.last_backup_id) {
            const m = await labelProvider.readBackupSnapshot(state.last_backup_id);
            if (m) {
                lastBackupObj = {
                    backup_id: state.last_backup_id,
                    operation: m.op_type || 'batch',
                    description: m.op_type || '上一步變更',
                    timestamp: m.timestamp || ''
                };
            }
        }

        const formattedLogs = formatAuditLogs(state);
        const sessionData = {
            last_backup_id: state.last_backup_id || null,
            saved_master_groups: state.saved_master_groups || [],
            review_queue: validQueue,
            last_active_stem: lastActive,
            last_master_stem: lastMaster,
            last_filter: state.last_filter || 'all',
            last_batch_stats: state.last_batch_stats || null,
            audit_logs: formattedLogs
        };

        const wsToken = `webws::${imageProvider.virtualPath}::${labelProvider.virtualPath}`;
        activeState.workspaceId = wsToken;

        return {
            ok: true,
            workspace_id: wsToken,
            image_dir: imageProvider.virtualPath,
            image_dir_name: imageProvider.name,
            folder_name: imageProvider.name,
            label_dir: labelProvider.virtualPath,
            label_dir_name: labelProvider.name,
            same_folder_mode: imageProvider.virtualPath === labelProvider.virtualPath,
            classes: classesInfo.classes.map(c => c.name),
            classes_path: classesInfo.path,
            classes_file_exists: classesInfo.exists,
            candidate_class_files: classesInfo.candidate_files,
            classes_info: classesInfo,
            class_usage: Object.keys(classUsageStats).map(Number).sort((a, b) => a - b).map(k => classUsageStats[k]),
            issue_groups: Array.from(issueGroupsMap.values()),
            summary,
            items,
            project_state: sessionData,
            session: sessionData,
            last_backup: lastBackupObj,
            audit_logs: formattedLogs
        };
    }

    // ========================================================================
    // 7. 1:1 移植 core/grouper.py (64-bit dHash 外觀相似度推薦)
    // ========================================================================
    async function handleGroupApi(payload) {
        const scanRes = await performFullScan();
        if (!scanRes.ok) return scanRes;

        const similarityThreshold = Number(payload.threshold ?? payload.similarity_threshold ?? 0.75);
        const preferredMasterStem = payload.master_stem || null;

        const validItems = scanRes.items.filter(it => it.has_image);
        const imageProvider = activeState.imageProvider;

        // 批次分塊計算 dHash（每批 8 張並讓出主執行緒，2,000+ 張照片亦不凍結畫面）
        const itemsNeedingHash = validItems.filter(it => !it.dhash || it.dhash.length === 0);
        const BATCH_SIZE = 8;
        for (let i = 0; i < itemsNeedingHash.length; i += BATCH_SIZE) {
            const chunk = itemsNeedingHash.slice(i, i + BATCH_SIZE);
            await Promise.all(chunk.map(async (it) => {
                const meta = await imageProvider.getImageEntry(it.image_name, { needDHash: true });
                it.dhash = meta.dhash || new Uint8Array(0);
            }));
            if (i > 0 && i % 24 === 0) {
                await yieldToMainThread();
            }
        }

        let candidateMasters = validItems.filter(it => it.pair_type === 'paired' && it.box_count > 0 && !it.has_blocking_error);

        if (preferredMasterStem) {
            const preferred = candidateMasters.filter(it => it.stem === preferredMasterStem);
            if (preferred.length === 0) {
                return { ok: false, error: '選定的參考照片不存在或標記格式有誤。' };
            }
            candidateMasters = preferred;
        }

        const groupsOut = [];
        const unassignedItems = [];

        if (candidateMasters.length > 0) {
            const masterBuckets = new Map();
            candidateMasters.forEach(m => masterBuckets.set(m.stem, []));

            for (const it of validItems) {
                if (candidateMasters.some(m => m.stem === it.stem)) continue;

                let bestMaster = null;
                let bestRatio = -1.0;
                let bestDist = 64;
                let totalBits = 64;

                for (const m of candidateMasters) {
                    const [ratio, dist, tBits] = computeHashMatch(it.dhash, m.dhash);
                    if (ratio > bestRatio) {
                        bestRatio = ratio;
                        bestDist = dist;
                        totalBits = tBits;
                        bestMaster = m;
                    }
                }

                if (bestMaster && bestRatio >= similarityThreshold) {
                    masterBuckets.get(bestMaster.stem).push({
                        stem: it.stem,
                        image_name: it.image_name,
                        pair_type: it.pair_type,
                        box_count: it.box_count,
                        similarity: bestRatio,
                        hamming_distance: bestDist,
                        metric_label: `特徵一致 ${Math.round(bestRatio * 100)}% (差異 ${bestDist}/${totalBits} 格)`,
                        reason: `與參考照片 ${bestMaster.image_name} 外觀雜湊一致度 ${Math.round(bestRatio * 100)}%（差異 ${bestDist}/${totalBits} 格）`
                    });
                } else {
                    unassignedItems.push({
                        stem: it.stem,
                        image_name: it.image_name,
                        best_candidate: bestMaster ? bestMaster.stem : '',
                        best_similarity: bestRatio > 0 ? bestRatio : 0.0,
                        reason: `外觀特徵一致度僅 ${Math.round(Math.max(0, bestRatio) * 100)}%（低於篩選門檻 ${Math.round(similarityThreshold * 100)}%），不自動歸入`
                    });
                }
            }

            candidateMasters.forEach((m, idx) => {
                const tList = masterBuckets.get(m.stem) || [];
                if (tList.length === 0) return;
                const avgSim = tList.reduce((acc, x) => acc + x.similarity, 0) / tList.length;
                groupsOut.push({
                    group_id: `grp_vis_${idx + 1}`,
                    group_name: `與「${m.image_name}」構圖接近的照片`,
                    basis: `共 ${tList.length} 張照片（平均外觀雜湊一致度 ${Math.round(avgSim * 100)}%，門檻 ${Math.round(similarityThreshold * 100)}%）`,
                    recommended_master: m.stem,
                    has_master: true,
                    confidence: avgSim >= 0.85 ? 'high' : 'medium',
                    note: '相似度僅協助篩選構圖接近的照片，不代表標記框位置一定正確，套用後請逐張確認',
                    targets: tList.sort((a, b) => b.similarity - a.similarity)
                });
            });
        }

        return {
            ok: true,
            method: 'visual',
            candidate_master_count: candidateMasters.length,
            warnings: [],
            groups: groupsOut,
            unassigned: unassignedItems
        };
    }

    // ========================================================================
    // 8. 1:1 移植 core/batch_ops.py (批次套用、類別修正、單張儲存、Ctrl+Z 還原)
    // ========================================================================
    async function computeMasterCopyPreview(payload) {
        const scanRes = await performFullScan();
        if (!scanRes.ok) return scanRes;

        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        const outDirStr = (payload.output_dir || '').trim();
        const outProvider = (outDirStr && dirProviders.has(outDirStr)) ? dirProviders.get(outDirStr) : labelProvider;
        const isSameAsLabelDir = outProvider.virtualPath === labelProvider.virtualPath;

        let assignments = payload.assignments;
        if (!assignments && payload.master_stem) {
            assignments = [{
                master_stem: payload.master_stem,
                target_stems: payload.target_stems || []
            }];
        }
        assignments = assignments || [];

        const selectedClassIds = ('selected_classes' in payload) ? payload.selected_classes : payload.selected_class_ids;
        const overwriteExisting = Boolean(payload.overwrite ?? payload.overwrite_existing ?? false);

        const blockingReasons = [];
        const summary = {
            total_targets: 0,
            will_create: 0,
            will_overwrite: 0,
            will_skip_existing: 0,
            size_mismatch_warnings: 0,
            invalid_masters: 0,
            output_dir: outProvider.virtualPath,
            output_dir_name: outProvider.name,
            is_same_as_label_dir: isSameAsLabelDir,
            blocking_reasons: blockingReasons
        };

        if (scanRes.classes_info.status === 'error') {
            blockingReasons.push('類別定義檔有錯誤，請先修正再套用標記。');
        }
        if (assignments.length === 0) {
            blockingReasons.push('尚未選擇參考照片或目標照片。');
        }

        const itemMap = new Map(scanRes.items.map(i => [i.stem, i]));
        const previewItems = [];
        const seenTargets = new Set();

        for (const group of assignments) {
            const masterStem = (group.master_stem || '').trim();
            const targetStems = group.target_stems || [];
            const groupName = group.group_name || `參考照片 ${masterStem}`;

            if (!masterStem) {
                blockingReasons.push('尚未指定參考照片。');
                continue;
            }
            const mItem = itemMap.get(masterStem);
            if (!mItem || !mItem.has_image || mItem.pair_type === 'ambiguous') {
                blockingReasons.push(`參考照片 ${masterStem} 不存在或有同名照片衝突。`);
                continue;
            }
            if (!mItem.has_label) {
                summary.invalid_masters += 1;
                blockingReasons.push(`參考照片 \`${masterStem}\` 沒有對應的 .txt 標記檔，無法作為複製來源。`);
                continue;
            }
            if (mItem.has_blocking_error) {
                blockingReasons.push(`參考照片 \`${masterStem}\` 本身含有格式或類別錯誤，請先修正後再作為複製來源。`);
            }

            let filteredBoxes = mItem.boxes || [];
            if (Array.isArray(selectedClassIds)) {
                const allowed = new Set(selectedClassIds.map(Number));
                filteredBoxes = filteredBoxes.filter(b => allowed.has(Number(b.class_id)));
            }
            if (filteredBoxes.length === 0) {
                blockingReasons.push(`篩選類別後，參考照片 \`${masterStem}\` 可複製的標記框數為 0，請至少勾選一個包含標記框的類別。`);
            }

            for (const tStem of targetStems) {
                if (tStem === masterStem) continue;
                const key = tStem.toLowerCase();
                if (seenTargets.has(key)) {
                    blockingReasons.push(`目標照片 ${tStem} 重複指派，請每張照片只指定一個來源。`);
                    continue;
                }
                seenTargets.add(key);

                const tItem = itemMap.get(tStem);
                if (!tItem || !tItem.has_image) {
                    blockingReasons.push(`目標照片 ${tStem} 不存在或無法讀取。`);
                    continue;
                }

                summary.total_targets += 1;
                const alreadyExists = await outProvider.fileExists(`${tStem}.txt`);
                const warnings = [];
                let hasAspectDiff = false;

                if (mItem.width > 0 && tItem.width > 0) {
                    const arDiff = Math.abs(mItem.aspect_ratio - tItem.aspect_ratio);
                    if (arDiff > 0.015) {
                        hasAspectDiff = true;
                        summary.size_mismatch_warnings += 1;
                        warnings.push(`長寬比不同：參考照片為 ${mItem.width}×${mItem.height}，此照片為 ${tItem.width}×${tItem.height}，套用後請務必微調框比例`);
                    } else if (mItem.width !== tItem.width || mItem.height !== tItem.height) {
                        warnings.push(`尺寸不同但比例一致：${mItem.width}×${mItem.height} → ${tItem.width}×${tItem.height}`);
                    }
                }

                let action = 'create';
                let actionLabel = '新增標記草稿';
                if (alreadyExists && !overwriteExisting) {
                    action = 'skip';
                    actionLabel = '略過（保留既有標記）';
                    summary.will_skip_existing += 1;
                } else if (alreadyExists && overwriteExisting) {
                    action = 'overwrite';
                    actionLabel = '備份後覆蓋';
                    summary.will_overwrite += 1;
                    warnings.unshift('已有標記檔，執行時將先自動備份原檔再覆蓋');
                } else {
                    summary.will_create += 1;
                }

                const actMap = { create: 'will_create', overwrite: 'will_overwrite', skip: 'skip_existing' };
                previewItems.push({
                    group_name: groupName,
                    master_stem: masterStem,
                    target_stem: tStem,
                    image_name: tItem.image_name,
                    already_exists: alreadyExists,
                    raw_action: action,
                    action: actMap[action] || action,
                    action_label: actionLabel,
                    reason: actionLabel,
                    resolution: tItem.width > 0 ? `${tItem.width}×${tItem.height}` : '-',
                    box_count_to_copy: filteredBoxes.length,
                    has_aspect_diff: hasAspectDiff,
                    warnings,
                    preview_boxes: filteredBoxes
                });
            }
        }

        if (summary.total_targets === 0 && blockingReasons.length === 0) {
            blockingReasons.push('請至少選擇一張不同於參考照片的目標照片。');
        }
        const willWriteTotal = summary.will_create + summary.will_overwrite;
        if (summary.total_targets > 0 && willWriteTotal === 0 && blockingReasons.length === 0) {
            blockingReasons.push(`勾選的 ${summary.total_targets} 張照片皆已有標記檔且目前已開啟「保護既有標記（不覆蓋）」。若確實要重新套用，請於進階設定勾選「覆蓋既有標記」。`);
        }

        summary.will_create_count = summary.will_create;
        summary.will_overwrite_count = summary.will_overwrite;
        summary.will_skip_count = summary.will_skip_existing;
        summary.aspect_warning_count = summary.size_mismatch_warnings;

        const mStem = (assignments[0] && assignments[0].master_stem) || '';
        const mItem = itemMap.get(mStem);
        let mBoxes = mItem ? (mItem.boxes || []) : [];
        if (Array.isArray(selectedClassIds)) {
            const allowed = new Set(selectedClassIds.map(Number));
            mBoxes = mBoxes.filter(b => allowed.has(Number(b.class_id)));
        }

        return {
            ok: true,
            summary,
            items: previewItems,
            preview_items: previewItems,
            master: {
                stem: mStem,
                image_name: mItem ? mItem.image_name : mStem,
                filtered_box_count: mBoxes.length
            },
            output_dir_name: summary.output_dir_name,
            blocking_reasons: blockingReasons,
            _outProvider: outProvider
        };
    }

    async function loadImageElementByStem(stem) {
        const objUrl = activeState.imageUrlByStem.get(stem);
        if (!objUrl) return null;
        try {
            return await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('Image load failed'));
                im.src = objUrl;
            });
        } catch (_) {
            return null;
        }
    }

    async function handleMasterCopyExecute(payload) {
        const preview = await computeMasterCopyPreview(payload);
        if (!preview.ok) return preview;
        if (preview.blocking_reasons && preview.blocking_reasons.length > 0) {
            return { ok: false, error: preview.blocking_reasons.join('；') };
        }

        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        const outProvider = preview._outProvider || labelProvider;
        const inPlace = outProvider.virtualPath === labelProvider.virtualPath;

        const state = await loadProjectState(labelProvider);
        const itemRecords = state.item_records || {};
        state.item_records = itemRecords;
        const prevRecordsSnapshot = JSON.parse(JSON.stringify(itemRecords));
        const prevQueueSnapshot = [...(state.review_queue || [])];

        const backupId = makeBackupId('copy');
        const snapshot = {
            backup_id: backupId,
            op_type: 'master_copy',
            timestamp: nowStr(),
            target_out_dir: outProvider.virtualPath,
            created_files: [],
            overwritten_files: [], // [{ filename, old_content }]
            previous_item_records: prevRecordsSnapshot,
            previous_review_queue: prevQueueSnapshot,
            previous_session: {
                last_active_stem: state.last_active_stem,
                last_master_stem: state.last_master_stem,
                last_batch_stats: state.last_batch_stats
            }
        };

        const results = {
            success_count: 0,
            created_count: 0,
            skipped_count: 0,
            needs_check_count: 0,
            failed_count: 0,
            processed_stems: [],
            output_dir: outProvider.virtualPath,
            in_place: inPlace,
            backup_id: backupId,
            details: [],
            failed: []
        };

        for (const item of preview.preview_items) {
            const tStem = item.target_stem;
            const mStem = item.master_stem;
            const filename = `${tStem}.txt`;

            if (item.raw_action === 'skip') {
                results.skipped_count += 1;
                results.details.push({
                    target_stem: tStem,
                    master_stem: mStem,
                    status: 'skipped',
                    message: '已有標記檔，依保護規則略過'
                });
                continue;
            }

            try {
                if (await outProvider.fileExists(filename)) {
                    const oldFile = await outProvider.readTextFile(filename);
                    snapshot.overwritten_files.push({
                        filename,
                        old_content: oldFile.text
                    });
                } else {
                    snapshot.created_files.push(filename);
                }

                let boxesToWrite = item.preview_boxes || [];
                let alignedBoxCount = 0;
                if (payload.smart_align && boxesToWrite.length > 0 && typeof window !== 'undefined' && window.YoloSmartAlign) {
                    const mImg = await loadImageElementByStem(mStem);
                    const tImg = await loadImageElementByStem(tStem);
                    if (mImg && tImg) {
                        const alignRes = window.YoloSmartAlign.alignBoxesFromImageElements(mImg, tImg, boxesToWrite);
                        boxesToWrite = alignRes.boxes;
                        alignedBoxCount = alignRes.alignedCount;
                    }
                }

                const linesToWrite = boxesToWrite.map(b => b.raw);
                const content = linesToWrite.join('\n') + (linesToWrite.length > 0 ? '\n' : '');
                await outProvider.writeTextFile(filename, content);

                if (inPlace) {
                    itemRecords[tStem] = {
                        master_source: mStem,
                        review_state: item.has_aspect_diff ? 'needs_refinement' : 'unreviewed_copy',
                        confirmed_hash: '',
                        updated_at: nowStr()
                    };
                }

                results.success_count += 1;
                results.needs_check_count += 1;
                results.processed_stems.push(tStem);
                results.details.push({
                    target_stem: tStem,
                    master_stem: mStem,
                    status: 'success',
                    box_count: linesToWrite.length,
                    aligned_box_count: alignedBoxCount,
                    has_aspect_diff: item.has_aspect_diff,
                    message: `已由參考照片 ${mStem} 建立 ${linesToWrite.length} 個標記框草稿（待人工確認）`
                });
            } catch (err) {
                results.failed_count += 1;
                results.failed.push({ stem: tStem, error: err.message });
                results.details.push({
                    target_stem: tStem,
                    master_stem: mStem,
                    status: 'failed',
                    message: `寫入失敗: ${err.message}`
                });
            }
        }

        results.created_count = results.success_count;
        await labelProvider.writeBackupSnapshot(backupId, snapshot);

        if (inPlace && results.processed_stems.length > 0) {
            state.review_queue = results.processed_stems;
            state.last_active_stem = results.processed_stems[0];
            state.last_batch_stats = {
                created_count: results.success_count,
                timestamp: nowStr()
            };
        }
        state.last_backup_id = backupId;
        await saveProjectState(labelProvider, state);
        await appendAuditLog(labelProvider, {
            op_type: '批次套用參考照片標記',
            backup_id: backupId,
            success_count: results.success_count
        });

        const nextScan = await performFullScan();
        return {
            ok: results.failed_count === 0,
            results,
            scan: nextScan,
            error: results.failed_count === 0 ? '' : `已完成 ${results.success_count} 張，失敗 ${results.failed_count} 張`
        };
    }

    async function handleSaveSingleLabel(payload) {
        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        const imageProvider = activeState.imageProvider;
        if (!labelProvider || !imageProvider) {
            return { ok: false, error: '無效的標記資料夾或檔名' };
        }
        const stem = (payload.stem || '').trim();
        const boxes = payload.boxes;
        if (!stem || !Array.isArray(boxes)) {
            return { ok: false, error: '無效的檔名或標記框陣列' };
        }

        const classesInfo = await parseClassesFromProvider(labelProvider, imageProvider, activeState.classesPath);
        const currentClassMap = { ...classesInfo.class_map };
        const definedClasses = Array.isArray(payload.defined_classes) ? payload.defined_classes : [];
        let classesModified = false;

        try {
            for (const b of boxes) {
                const cid = Number(b.class_id);
                if (!Number.isInteger(cid) || cid < 0) throw new Error('類別編號必須為非負整數');
                const cname = String(b.class_name || '').trim();
                if (!Object.prototype.hasOwnProperty.call(currentClassMap, cid)) {
                    const curLen = Object.keys(currentClassMap).length;
                    if (cname && cid === curLen) {
                        currentClassMap[cid] = cname;
                        classesModified = true;
                    } else if (definedClasses.length > cid && String(definedClasses[cid] || '').trim()) {
                        for (let k = curLen; k <= cid; k++) {
                            const kName = String(definedClasses[k] || '').trim() || `class_${k}`;
                            currentClassMap[k] = kName;
                        }
                        classesModified = true;
                    } else if (curLen > 0) {
                        throw new Error('類別編號不在類別檔範圍內');
                    }
                }
                const xc = Number(b.xc ?? b.x_center);
                const yc = Number(b.yc ?? b.y_center);
                const w = Number(b.w ?? b.width);
                const h = Number(b.h ?? b.height);
                if (![xc, yc, w, h].every(Number.isFinite) || !(xc >= 0 && xc <= 1 && yc >= 0 && yc <= 1 && w > 0 && w <= 1 && h > 0 && h <= 1)) {
                    throw new Error('座標範圍錯誤');
                }
            }
        } catch (err) {
            return { ok: false, error: err.message };
        }

        const state = await loadProjectState(labelProvider);
        const itemRecords = state.item_records || {};
        state.item_records = itemRecords;
        const prevRecordsSnapshot = JSON.parse(JSON.stringify(itemRecords));

        const backupId = makeBackupId('edit');
        const filename = `${stem}.txt`;
        const classesFilename = classesInfo.filename || 'classes.txt';

        const snapshot = {
            backup_id: backupId,
            op_type: 'canvas_box_edit',
            timestamp: nowStr(),
            target_out_dir: labelProvider.virtualPath,
            created_files: [],
            overwritten_files: [],
            previous_item_records: prevRecordsSnapshot
        };

        if (await labelProvider.fileExists(filename)) {
            const oldFile = await labelProvider.readTextFile(filename);
            snapshot.overwritten_files.push({ filename, old_content: oldFile.text });
        } else {
            snapshot.created_files.push(filename);
        }

        if (classesModified) {
            if (await labelProvider.fileExists(classesFilename)) {
                const oldCls = await labelProvider.readTextFile(classesFilename);
                snapshot.overwritten_files.push({ filename: classesFilename, old_content: oldCls.text });
            } else {
                snapshot.created_files.push(classesFilename);
            }
        }

        const lines = boxes.map(b => {
            const cid = parseInt(b.class_id, 10);
            const xc = Math.max(0.0, Math.min(1.0, Number(b.xc ?? b.x_center)));
            const yc = Math.max(0.0, Math.min(1.0, Number(b.yc ?? b.y_center)));
            const w = Number(b.w ?? b.width);
            const h = Number(b.h ?? b.height);
            return `${cid} ${xc.toFixed(9)} ${yc.toFixed(9)} ${w.toFixed(9)} ${h.toFixed(9)}`;
        });
        const content = lines.join('\n') + (lines.length > 0 ? '\n' : '');
        await labelProvider.writeTextFile(filename, content);

        const totalCls = Object.keys(currentClassMap).length;
        const orderedNames = [];
        for (let i = 0; i < totalCls; i++) {
            orderedNames.push(currentClassMap[i]);
        }
        if (classesModified) {
            const clsContent = orderedNames.join('\n') + (orderedNames.length > 0 ? '\n' : '');
            await labelProvider.writeTextFile(classesFilename, clsContent);
        }

        await labelProvider.writeBackupSnapshot(backupId, snapshot);

        const parsedSingle = parseAndValidateYoloTxtContent(content, currentClassMap, totalCls > 0);
        const currHash = computeNormalizedContentHash(content);
        const rec = itemRecords[stem] || {};
        if (payload.confirm && !parsedSingle.has_blocking_error && lines.length > 0) {
            rec.review_state = 'confirmed';
            rec.confirmed_hash = currHash;
        } else {
            rec.review_state = '';
            rec.confirmed_hash = '';
        }
        rec.updated_at = nowStr();
        itemRecords[stem] = rec;
        state.last_backup_id = backupId;

        const logs = Array.isArray(state.audit_logs) ? state.audit_logs : [];
        logs.unshift({
            op_type: payload.confirm ? `畫布確認並儲存 (${stem}.txt)` : `畫布草稿儲存 (${stem}.txt)`,
            backup_id: backupId,
            box_count: lines.length,
            timestamp: nowStr()
        });
        state.audit_logs = logs.slice(0, 100);
        await saveProjectState(labelProvider, state);

        if (payload.fast_single) {
            const isConfirmed = rec.review_state === 'confirmed';
            const hasBlocking = parsedSingle.has_blocking_error;
            const hasWarn = parsedSingle.issues.some(i => i.level === 'warning');
            const finalClassesPath = classesInfo.path || `${labelProvider.virtualPath}/${classesFilename}`;
            if (classesModified && !classesInfo.path) activeState.classesPath = finalClassesPath;
            return {
                ok: true,
                fast_single: true,
                backup_id: backupId,
                box_count: lines.length,
                confirmed: isConfirmed,
                classes: orderedNames,
                classes_file_exists: classesModified ? true : classesInfo.exists,
                classes_path: finalClassesPath,
                last_backup: {
                    backup_id: backupId,
                    operation: 'canvas_box_edit',
                    description: `畫布儲存 (${stem}.txt)`,
                    timestamp: snapshot.timestamp
                },
                item_patch: {
                    stem,
                    label_name: filename,
                    pair_type: 'paired',
                    pair_label: parsedSingle.is_empty_file ? '空白標記檔 (0 框)' : '已配對',
                    format_status: parsedSingle.format_status,
                    format_label: parsedSingle.format_label,
                    review_status: isConfirmed ? 'confirmed' : (hasBlocking ? 'needs_fix' : 'pending_review'),
                    review_label: isConfirmed ? '已確認' : (hasBlocking ? '需修正' : '待人工確認'),
                    review_state: isConfirmed ? 'confirmed' : (hasBlocking ? 'needs_refinement' : ''),
                    has_blocking_error: hasBlocking,
                    is_empty_file: parsedSingle.is_empty_file,
                    is_valid_reference: parsedSingle.boxes.length > 0 && !hasBlocking,
                    status: hasBlocking ? 'error' : (hasWarn ? 'warning' : 'pass'),
                    box_count: parsedSingle.boxes.length,
                    boxes: parsedSingle.boxes,
                    content_hash: currHash,
                    issues: parsedSingle.issues.map(iss => ({
                        ...iss,
                        message: iss.message || (iss.suggestion ? `${iss.reason}（${iss.suggestion}）` : iss.reason)
                    })),
                    has_label: true
                }
            };
        }

        const nextScan = await performFullScan();
        return {
            ok: true,
            backup_id: backupId,
            box_count: lines.length,
            confirmed: rec.review_state === 'confirmed',
            scan: nextScan
        };
    }

    async function handleUpdateReviewState(payload) {
        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        const imageProvider = activeState.imageProvider;
        if (!labelProvider || !imageProvider) {
            return { ok: false, error: '標記資料夾無效' };
        }
        const stems = payload.stems || (payload.stem ? [payload.stem] : []);
        const reviewState = ('state' in payload) ? payload.state : (payload.review_state ?? 'confirmed');
        const allowEmpty = Boolean(payload.allow_empty);

        if (!stems.length) return { ok: false, error: '目標檔名無效' };

        const classesInfo = await parseClassesFromProvider(labelProvider, imageProvider, activeState.classesPath);
        const classMap = classesInfo.class_map;
        const hasClasses = classesInfo.exists && Object.keys(classMap).length > 0;

        const state = await loadProjectState(labelProvider);
        const itemRecords = state.item_records || {};
        state.item_records = itemRecords;

        for (const st of stems) {
            const filename = `${st}.txt`;
            if (reviewState === 'confirmed') {
                const exists = await labelProvider.fileExists(filename);
                if (!exists) {
                    if (allowEmpty) {
                        const backupId = makeBackupId('empty');
                        const prevRecordsSnapshot = JSON.parse(JSON.stringify(itemRecords));
                        await labelProvider.writeTextFile(filename, '');
                        await labelProvider.writeBackupSnapshot(backupId, {
                            backup_id: backupId,
                            op_type: 'confirm_empty_photo',
                            timestamp: nowStr(),
                            target_out_dir: labelProvider.virtualPath,
                            created_files: [filename],
                            overwritten_files: [],
                            previous_item_records: prevRecordsSnapshot
                        });
                        state.last_backup_id = backupId;
                    } else {
                        return {
                            ok: false,
                            error: `照片 \`${st}\` 尚未建立標記檔 (.txt)。若此照片確實沒有目標物件，請點擊「確認為無物件照片」；否則請先套用參考照片或於畫布按「＋ 新增框 (W)」標記。`
                        };
                    }
                }
                const lblData = await labelProvider.readTextFile(filename);
                const parsed = parseAndValidateYoloTxtContent(lblData.text, classMap, hasClasses);
                if (parsed.is_empty_file && !allowEmpty) {
                    return { ok: false, error: `標記檔 \`${st}.txt\` 為空白檔 (0 個標記框)。若確認為無物件背景照片，請使用無物件確認選項。` };
                }
                if (parsed.has_blocking_error) {
                    const reasons = parsed.issues.filter(i => i.blocking).map(i => i.reason).join('；');
                    return { ok: false, error: `無法確認 \`${st}\`：標記檔仍有阻擋性錯誤（${reasons}），請先修正後再確認。` };
                }
                const currHash = computeNormalizedContentHash(lblData.text);
                const rec = itemRecords[st] || {};
                rec.review_state = 'confirmed';
                rec.confirmed_hash = currHash;
                rec.updated_at = nowStr();
                itemRecords[st] = rec;
            } else {
                const rec = itemRecords[st] || {};
                rec.review_state = reviewState;
                rec.confirmed_hash = '';
                rec.updated_at = nowStr();
                itemRecords[st] = rec;
            }
        }

        await saveProjectState(labelProvider, state);
        return { ok: true, updated_count: stems.length, review_state: reviewState };
    }

    async function computeClassRemapPreview(payload) {
        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        const imageProvider = activeState.imageProvider;
        const classesInfo = await parseClassesFromProvider(labelProvider, imageProvider, activeState.classesPath);
        const oldMap = classesInfo.class_map;

        let remapRules = payload.remap_rules;
        const newClasses = payload.new_classes || [];
        if (!Array.isArray(remapRules)) {
            const mapping = payload.mapping || {};
            remapRules = Object.entries(mapping).map(([kStr, targetVal]) => {
                const oldId = parseInt(kStr, 10);
                if (targetVal === null) {
                    return { old_id: oldId, action: 'delete', new_id: -1, new_name: oldMap[oldId] || `class_${oldId}` };
                }
                const newId = parseInt(targetVal, 10);
                return {
                    old_id: oldId,
                    action: newId !== oldId ? 'remap' : 'keep',
                    new_id: newId,
                    new_name: (newId >= 0 && newId < newClasses.length) ? newClasses[newId] : (oldMap[oldId] || `class_${oldId}`)
                };
            });
            if (remapRules.length > 0 && newClasses.length > 0) {
                remapRules[0].class_definitions = newClasses;
            }
        }

        const ruleByOldId = {};
        const newClassesDict = {};
        const targetIdSources = {};
        const validationErrors = [];

        const suppliedIds = new Set(remapRules.map(r => parseInt(r.old_id, 10)));
        const fullRules = [
            ...remapRules,
            ...Object.entries(oldMap)
                .filter(([cid]) => !suppliedIds.has(parseInt(cid, 10)))
                .map(([cid, name]) => ({ old_id: parseInt(cid, 10), new_id: parseInt(cid, 10), action: 'keep', new_name: name }))
        ];

        for (const r of fullRules) {
            const oldId = parseInt(r.old_id, 10);
            const action = r.action || 'keep';
            const newId = action !== 'delete' ? parseInt(r.new_id ?? oldId, 10) : -1;
            const newName = String(r.new_name ?? oldMap[oldId] ?? `class_${oldId}`).trim();
            const oldName = oldMap[oldId] || `未定義(${oldId})`;

            if (action !== 'delete') {
                if (newId < 0) validationErrors.push(`原類別 ID ${oldId} 的新編號不可為負數 (${newId})。`);
                if (!newName) validationErrors.push(`新類別 ID ${newId} 的名稱不可為空白。`);
                if (!targetIdSources[newId]) targetIdSources[newId] = [];
                targetIdSources[newId].push(oldId);
                newClassesDict[newId] = newName;
            }

            let impactType = 'unchanged';
            let impactLabel = '維持不變';
            if (action === 'delete') {
                impactType = 'delete_boxes';
                impactLabel = '刪除該類別所有標記框（修改 .txt 檔）';
            } else if (newId !== oldId) {
                impactType = 'change_id';
                impactLabel = `變更類別編號 ${oldId} → ${newId}（修改 .txt 檔）`;
            } else if (newName !== oldName) {
                impactType = 'rename_only';
                impactLabel = '僅修改類別名稱（只更新 classes.txt，不改動 .txt 檔）';
            }

            ruleByOldId[oldId] = {
                old_id: oldId,
                old_name: oldName,
                action,
                new_id: newId,
                new_name: newName,
                impact_type: impactType,
                impact_label: impactLabel,
                affected_files: 0,
                affected_boxes: 0
            };
        }

        const explicitRule = fullRules.find(r => Array.isArray(r.class_definitions));
        if (explicitRule) {
            Object.keys(newClassesDict).forEach(k => delete newClassesDict[k]);
            explicitRule.class_definitions.forEach((n, idx) => { newClassesDict[idx] = n; });
        }

        const classesBasename = (classesInfo.filename || 'classes.txt').toLowerCase();
        const entries = await labelProvider.listFiles();

        let totalFilesScanned = 0;
        let totalTxtFilesModified = 0;
        let totalBoxesIdChanged = 0;
        let totalBoxesRenamedOnly = 0;
        let totalBoxesDeleted = 0;

        for (const entry of entries) {
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith('.txt') || RESERVED_CLASS_FILENAMES.has(lower) || lower === classesBasename) continue;

            totalFilesScanned += 1;
            let txtFileModified = false;
            const seenOldIdsInFile = new Set();

            const fileData = await labelProvider.readTextFile(entry.name);
            const lines = fileData.text.split(/\r?\n/);
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                if (parts.length !== 5) continue;
                const cid = parseInt(parts[0], 10);
                if (Number.isNaN(cid) || !ruleByOldId[cid]) continue;

                const rule = ruleByOldId[cid];
                seenOldIdsInFile.add(cid);
                rule.affected_boxes += 1;
                if (rule.action === 'delete') {
                    txtFileModified = true;
                    totalBoxesDeleted += 1;
                } else if (rule.new_id !== cid) {
                    txtFileModified = true;
                    totalBoxesIdChanged += 1;
                } else if (rule.new_name !== rule.old_name) {
                    totalBoxesRenamedOnly += 1;
                }
            }
            for (const cid of seenOldIdsInFile) {
                ruleByOldId[cid].affected_files += 1;
            }
            if (txtFileModified) totalTxtFilesModified += 1;
        }

        const newIds = Object.keys(newClassesDict).map(Number);
        const maxId = newIds.length > 0 ? Math.max(...newIds) : -1;
        const newClassesList = [];
        const continuityWarnings = [];
        for (let i = 0; i <= maxId; i++) {
            if (!Object.prototype.hasOwnProperty.call(newClassesDict, i)) {
                continuityWarnings.push(`新類別編號缺少 ID ${i}！YOLO 的 classes.txt 依行號對應編號，跳號會產生空白類別行。`);
            }
            newClassesList.push({ id: i, name: newClassesDict[i] || '' });
        }

        const mappingSummary = Object.keys(ruleByOldId).map(Number).sort((a, b) => a - b).map(k => ruleByOldId[k]);
        return {
            ok: true,
            total_files_scanned: totalFilesScanned,
            total_files_modified: totalTxtFilesModified,
            total_boxes_modified: totalBoxesIdChanged,
            total_boxes_renamed_only: totalBoxesRenamedOnly,
            total_boxes_deleted: totalBoxesDeleted,
            will_update_classes_file: mappingSummary.some(r => ['rename_only', 'change_id', 'delete_boxes'].includes(r.impact_type)),
            mapping_summary: mappingSummary,
            new_classes_preview: newClassesList,
            merged_groups_info: [],
            continuity_warnings: continuityWarnings,
            validation_errors: validationErrors,
            preview: {
                affected_files_count: totalTxtFilesModified,
                remapped_boxes_count: totalBoxesIdChanged,
                deleted_boxes_count: totalBoxesDeleted,
                rename_only_classes: mappingSummary.filter(r => r.impact_type === 'rename_only')
            }
        };
    }

    async function handleClassRemapExecute(payload) {
        const preview = await computeClassRemapPreview(payload);
        const errors = [...(preview.validation_errors || []), ...(preview.continuity_warnings || [])];
        if (errors.length > 0) {
            return { ok: false, error: errors.join('；') };
        }

        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        const imageProvider = activeState.imageProvider;
        const classesInfo = await parseClassesFromProvider(labelProvider, imageProvider, activeState.classesPath);
        const classesFilename = classesInfo.filename || 'classes.txt';
        const classesBasename = classesFilename.toLowerCase();

        const ruleByOldId = {};
        for (const r of preview.mapping_summary) {
            ruleByOldId[r.old_id] = r;
        }

        const state = await loadProjectState(labelProvider);
        const itemRecords = state.item_records || {};
        state.item_records = itemRecords;
        const prevRecordsSnapshot = JSON.parse(JSON.stringify(itemRecords));

        const backupId = makeBackupId('remap');
        const snapshot = {
            backup_id: backupId,
            op_type: 'class_remap',
            timestamp: nowStr(),
            target_out_dir: labelProvider.virtualPath,
            created_files: [],
            overwritten_files: [],
            previous_item_records: prevRecordsSnapshot
        };

        const entries = await labelProvider.listFiles();
        let modifiedCount = 0;

        for (const entry of entries) {
            const lower = entry.name.toLowerCase();
            if (!lower.endsWith('.txt') || RESERVED_CLASS_FILENAMES.has(lower) || lower === classesBasename) continue;

            const [stem] = splitExt(entry.name);
            const fileData = await labelProvider.readTextFile(entry.name);
            const rawLines = fileData.text.split(/\r?\n/);
            let changed = false;
            const newLines = [];

            for (const line of rawLines) {
                const stripped = line.trim();
                if (!stripped) continue;
                const parts = stripped.split(/\s+/);
                const cid = parts.length === 5 ? parseInt(parts[0], 10) : NaN;
                const rule = !Number.isNaN(cid) ? ruleByOldId[cid] : null;
                if (rule && rule.action === 'delete') {
                    changed = true;
                    continue;
                }
                if (rule && rule.new_id !== cid) {
                    changed = true;
                    newLines.push(`${rule.new_id} ${parts.slice(1).join(' ')}`);
                } else {
                    newLines.push(stripped);
                }
            }

            if (changed) {
                snapshot.overwritten_files.push({ filename: entry.name, old_content: fileData.text });
                const newContent = newLines.join('\n') + (newLines.length > 0 ? '\n' : '');
                await labelProvider.writeTextFile(entry.name, newContent);
                modifiedCount += 1;

                if (itemRecords[stem]) {
                    itemRecords[stem].confirmed_hash = '';
                    if (itemRecords[stem].review_state === 'confirmed') {
                        itemRecords[stem].review_state = '';
                    }
                    itemRecords[stem].updated_at = nowStr();
                }
            }
        }

        const updateClassesTxt = payload.update_classes_txt !== false;
        if (updateClassesTxt) {
            if (await labelProvider.fileExists(classesFilename)) {
                const oldCls = await labelProvider.readTextFile(classesFilename);
                snapshot.overwritten_files.push({ filename: classesFilename, old_content: oldCls.text });
            } else {
                snapshot.created_files.push(classesFilename);
            }
            const names = preview.new_classes_preview.map(c => c.name);
            await labelProvider.writeTextFile(classesFilename, names.join('\n') + (names.length > 0 ? '\n' : ''));
        }

        await labelProvider.writeBackupSnapshot(backupId, snapshot);
        state.last_backup_id = backupId;
        await saveProjectState(labelProvider, state);
        await appendAuditLog(labelProvider, {
            op_type: '批次類別修正',
            backup_id: backupId,
            modified_files: modifiedCount
        });

        const nextScan = await performFullScan();
        return {
            ok: true,
            backup_id: backupId,
            modified_count: modifiedCount,
            classes_updated: updateClassesTxt,
            results: {
                modified_files_count: modifiedCount,
                classes_updated: updateClassesTxt
            },
            scan: nextScan
        };
    }

    async function handleUndo(payload) {
        const labelProvider = activeState.labelProvider || activeState.imageProvider;
        if (!labelProvider) return { ok: false, error: '請先載入照片資料夾' };

        const state = await loadProjectState(labelProvider);
        const targetBackupId = (payload && payload.backup_id) || state.last_backup_id;
        if (!targetBackupId) {
            return { ok: false, error: '目前沒有可復原的操作紀錄。' };
        }

        const snapshot = await labelProvider.readBackupSnapshot(targetBackupId);
        if (!snapshot) {
            return { ok: false, error: `找不到備份清單檔案 (${targetBackupId})，無法自動復原。` };
        }

        const targetProvider = dirProviders.get(snapshot.target_out_dir) || labelProvider;
        let restoredCount = 0;
        let removedCount = 0;

        for (const item of (snapshot.overwritten_files || [])) {
            await targetProvider.writeTextFile(item.filename, item.old_content);
            restoredCount += 1;
        }
        for (const createdName of (snapshot.created_files || [])) {
            await targetProvider.removeFile(createdName);
            removedCount += 1;
        }

        if (snapshot.previous_item_records) {
            state.item_records = snapshot.previous_item_records;
        }
        if (snapshot.previous_review_queue) {
            state.review_queue = snapshot.previous_review_queue;
        }
        if (snapshot.previous_session) {
            Object.assign(state, snapshot.previous_session);
        }

        await labelProvider.removeBackupSnapshot(targetBackupId);
        const remaining = await labelProvider.listBackupIds();
        state.last_backup_id = remaining.length > 0 ? remaining[remaining.length - 1] : null;
        await saveProjectState(labelProvider, state);
        await appendAuditLog(labelProvider, {
            op_type: `還原操作 (${targetBackupId})`,
            restored_files: restoredCount,
            removed_created_files: removedCount
        });

        const nextScan = await performFullScan();
        return {
            ok: true,
            backup_id: targetBackupId,
            restored_count: restoredCount,
            removed_count: removedCount,
            message: `已還原上一步操作（恢復 ${restoredCount} 檔、移除新增 ${removedCount} 檔）`,
            scan: nextScan
        };
    }

    // ========================================================================
    // 9. API 路由分派與 fetch 攔截層
    // ========================================================================
    async function dispatchApiRequest(pathname, payload) {
        if (pathname === '/api/pick_path') {
            const mode = payload.mode || 'folder';
            if (mode === 'file') {
                if (typeof window.showOpenFilePicker !== 'function') {
                    return { ok: false, error: '請使用桌面版 Microsoft Edge 或 Google Chrome 開啟此網頁以選擇檔案。' };
                }
                try {
                    const [fh] = await window.showOpenFilePicker({
                        multiple: false,
                        types: [{ description: 'Classes File', accept: { 'text/plain': ['.txt', '.names'] } }]
                    });
                    const vFile = `[本機檔案] ${fh.name}`;
                    customClassesFileHandles.set(vFile, { name: fh.name, handle: fh });
                    return { ok: true, path: vFile, cancelled: false };
                } catch (err) {
                    if (err && err.name === 'AbortError') return { ok: true, path: '', cancelled: true };
                    return { ok: false, error: `無法選擇檔案：${err.message}` };
                }
            } else {
                if (typeof window.showDirectoryPicker !== 'function') {
                    return {
                        ok: false,
                        error: '您的瀏覽器不支援直接讀寫本機資料夾 (File System Access API)，請改用桌面版 Microsoft Edge 或 Google Chrome 開啟此網頁。'
                    };
                }
                try {
                    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                    const vPath = await registerDirectoryHandle(dirHandle);
                    await saveRecentHandleToIdb('last_image_dir', dirHandle);
                    return { ok: true, path: vPath, cancelled: false, folder_name: dirHandle.name };
                } catch (err) {
                    if (err && err.name === 'AbortError') return { ok: true, path: '', cancelled: true };
                    return { ok: false, error: `無法讀取此資料夾（請避開系統根目錄並點選允許）：${err.message}` };
                }
            }
        }

        if (pathname === '/api/reset_sample') {
            const sampleProv = await buildSampleMemoryProvider();
            dirProviders.set(sampleProv.virtualPath, sampleProv);
            activeState.imageProvider = sampleProv;
            activeState.labelProvider = sampleProv;
            activeState.classesPath = `${sampleProv.virtualPath}/classes.txt`;
            return {
                ok: true,
                sample_dir: sampleProv.virtualPath,
                classes_path: activeState.classesPath
            };
        }

        if (pathname === '/api/scan') {
            const imgDir = (payload.image_dir || '').trim();
            const lblDir = (payload.label_dir || imgDir).trim();
            const clsPath = (payload.classes_path || '').trim();

            if (!dirProviders.has(imgDir)) {
                return { ok: false, error: '請點擊「選擇照片資料夾」按鈕並授權瀏覽器存取您的照片資料夾。' };
            }
            activeState.imageProvider = dirProviders.get(imgDir);
            activeState.labelProvider = dirProviders.get(lblDir) || activeState.imageProvider;
            activeState.classesPath = clsPath;
            return await performFullScan();
        }

        if (pathname === '/api/save_session') {
            const labelProvider = activeState.labelProvider || activeState.imageProvider;
            if (!labelProvider) return { ok: false };
            const state = await loadProjectState(labelProvider);
            if ('last_active_stem' in payload || 'active_stem' in payload) {
                state.last_active_stem = payload.last_active_stem || payload.active_stem;
            }
            if ('last_master_stem' in payload || 'master_stem' in payload) {
                state.last_master_stem = payload.last_master_stem || payload.master_stem;
            }
            if ('last_filter' in payload || 'current_filter' in payload) {
                state.last_filter = payload.last_filter || payload.current_filter;
            }
            if (Array.isArray(payload.review_queue)) {
                state.review_queue = payload.review_queue;
            }
            await saveProjectState(labelProvider, state);
            return { ok: true };
        }

        if (pathname === '/api/group' || pathname === '/api/recommend_groups') {
            return await handleGroupApi(payload);
        }

        if (pathname === '/api/master_copy/preview' || pathname === '/api/preview_master_copy') {
            const res = await computeMasterCopyPreview(payload);
            delete res._outProvider;
            return res;
        }

        if (pathname === '/api/master_copy/execute' || pathname === '/api/execute_master_copy') {
            return await handleMasterCopyExecute(payload);
        }

        if (pathname === '/api/class_remap/preview' || pathname === '/api/preview_class_remap') {
            return await computeClassRemapPreview(payload);
        }

        if (pathname === '/api/class_remap/execute' || pathname === '/api/execute_class_remap') {
            return await handleClassRemapExecute(payload);
        }

        if (pathname === '/api/update_review_state') {
            return await handleUpdateReviewState(payload);
        }

        if (pathname === '/api/save_single_label') {
            return await handleSaveSingleLabel(payload);
        }

        if (pathname === '/api/undo') {
            return await handleUndo(payload);
        }

        if (pathname === '/api/open_folder' || pathname === '/api/open_explorer') {
            return { ok: true };
        }

        return { ok: false, error: `未定義的 API 路徑: ${pathname}` };
    }

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function (input, init = {}) {
        const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        let pathname = urlStr;
        try {
            const u = new URL(urlStr, location.origin);
            pathname = u.pathname;
        } catch (_) {}

        const useWebEngine = Boolean(
            window.YOLO_WEB_MODE ||
            (activeState.workspaceId && activeState.workspaceId.startsWith('webws::'))
        );

        if (useWebEngine && pathname.startsWith('/api/')) {
            let payload = {};
            if (init && init.body) {
                try { payload = JSON.parse(init.body); } catch (_) {}
            }
            const resultObj = await dispatchApiRequest(pathname, payload);
            const status = resultObj && resultObj.ok === false ? 400 : 200;
            return new Response(JSON.stringify(resultObj), {
                status,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        try {
            return await nativeFetch(input, init);
        } catch (netErr) {
            if (pathname.startsWith('/api/')) {
                window.YOLO_WEB_MODE = true;
                let payload = {};
                if (init && init.body) {
                    try { payload = JSON.parse(init.body); } catch (_) {}
                }
                const resultObj = await dispatchApiRequest(pathname, payload);
                return new Response(JSON.stringify(resultObj), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            throw netErr;
        }
    };

    // ========================================================================
    // 10. 匯出給 main.js 與 GitHub Pages 介面適配使用
    // ========================================================================
    async function loadBuiltInSampleWorkspace() {
        const res = await fetch('/api/reset_sample', { method: 'POST' });
        const data = await res.json();
        if (data.ok) {
            document.getElementById('inputImageDir').value = data.sample_dir;
            document.getElementById('inputImageDirLoaded').value = data.sample_dir;
            document.getElementById('chkSameFolder').checked = true;
            document.getElementById('inputLabelDir').value = '';
            document.getElementById('inputClassesPath').value = '';
            if (typeof toggleSameFolderMode === 'function') toggleSameFolderMode();
            if (typeof scanCurrentWorkspace === 'function') {
                await scanCurrentWorkspace({ restoreSession: false });
            }
            if (typeof showToast === 'function') {
                showToast('已載入內建練習範例資料集（共 9 張照片），可直接體驗所有標記與批次功能！', 'success');
            }
        }
    }

    async function restoreLastAuthorizedDirectory(savedHandle) {
        try {
            if (typeof savedHandle.requestPermission === 'function') {
                const perm = await savedHandle.requestPermission({ mode: 'readwrite' });
                if (perm !== 'granted') {
                    if (typeof showToast === 'function') showToast('需要點選「允許」才能讀寫上次的資料夾', 'warn');
                    return;
                }
            }
            const vPath = await registerDirectoryHandle(savedHandle);
            document.getElementById('inputImageDir').value = vPath;
            document.getElementById('inputImageDirLoaded').value = vPath;
            document.getElementById('chkSameFolder').checked = true;
            document.getElementById('inputLabelDir').value = '';
            document.getElementById('inputClassesPath').value = '';
            if (typeof toggleSameFolderMode === 'function') toggleSameFolderMode();
            if (typeof scanCurrentWorkspace === 'function') {
                await scanCurrentWorkspace({ restoreSession: true });
            }
            if (typeof showToast === 'function') {
                showToast(`已恢復上次資料夾：${savedHandle.name}`, 'success');
            }
        } catch (err) {
            if (typeof showToast === 'function') {
                showToast(`無法恢復上次資料夾，請重新選擇：${err.message}`, 'warn');
            }
        }
    }

    function adaptWebModeUI() {
        if (!window.YOLO_WEB_MODE) return;
        document.body.classList.add('yolo-web-mode');

        // 1. 隱藏網頁無法呼叫的 Windows 檔案總管按鈕 (openInExplorer)
        document.querySelectorAll('button[onclick*="openInExplorer"]').forEach(btn => {
            btn.style.display = 'none';
        });

        // 2. 將路徑輸入框設為唯讀並支援點擊直接觸發選擇視窗（遵循瀏覽器安全沙盒）
        const pathInputs = [
            { id: 'inputImageDirLoaded', mode: 'folder', placeholder: '點擊右側「選擇資料夾...」授權存取' },
            { id: 'inputLabelDir', mode: 'folder', placeholder: '點擊右側「選擇...」指定標記資料夾' },
            { id: 'inputClassesPath', mode: 'file', placeholder: '自動尋找 classes.txt，或點擊右側指定' },
            { id: 'inputCopyOutputDir', mode: 'folder', placeholder: '預設：標記資料夾（可點右側選擇其他資料夾）' }
        ];
        for (const cfg of pathInputs) {
            const el = document.getElementById(cfg.id);
            if (el) {
                el.readOnly = true;
                el.placeholder = cfg.placeholder;
                el.style.cursor = 'pointer';
                el.title = '請點擊選擇本機資料夾或檔案';
                el.addEventListener('click', () => {
                    if (typeof pickPath === 'function') pickPath(cfg.id, cfg.mode);
                });
            }
        }

        // 3. 轉換首頁「手動貼上路徑」區塊為「繼續上次資料夾」快捷入口（已移除內建練習範例按鈕）
        const pathBox = document.querySelector('.welcome-path-box');
        if (pathBox) {
            const hasFsApi = typeof window.showDirectoryPicker === 'function';
            const browserNotice = hasFsApi
                ? ''
                : `<div style="margin-bottom:10px;padding:8px 12px;background:#FEF3C7;border:1px solid #F59E0B;border-radius:6px;color:#92400E;font-size:14px;">
                    ⚠️ 偵測到目前瀏覽器不支援直接讀寫本機資料夾，請使用桌面版 <strong>Microsoft Edge</strong> 或 <strong>Google Chrome</strong> 開啟本網頁。
                   </div>`;

            pathBox.style.display = hasFsApi ? 'none' : 'block';
            pathBox.innerHTML = `
                <input type="hidden" id="inputImageDir" value="">
                ${browserNotice}
                <div id="webQuickRestoreArea" style="display:none;"></div>
            `;

            loadRecentHandleFromIdb('last_image_dir').then(savedHandle => {
                const area = document.getElementById('webQuickRestoreArea');
                if (savedHandle && area) {
                    pathBox.style.display = 'block';
                    area.style.display = 'block';
                    area.innerHTML = `
                        <button type="button" class="btn btn-secondary" id="btnWebRestoreLast" style="width:100%;justify-content:center;font-weight:700;">
                            📂 繼續上次使用的資料夾：「${savedHandle.name}」
                        </button>
                    `;
                    document.getElementById('btnWebRestoreLast').addEventListener('click', () => {
                        restoreLastAuthorizedDirectory(savedHandle);
                    });
                }
            });
        }
    }

    function registerPwaServiceWorker() {
        if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator &&
            (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        }
    }

    window.addEventListener('DOMContentLoaded', () => {
        registerPwaServiceWorker();
        adaptWebModeUI();
    });

    window.YoloWebEngine = {
        isActive() {
            return Boolean(
                window.YOLO_WEB_MODE ||
                (activeState.workspaceId && activeState.workspaceId.startsWith('webws::'))
            );
        },
        getImageUrl(stem) {
            return activeState.imageUrlByStem.get(stem) || '';
        },
        loadBuiltInSampleWorkspace
    };
})();
