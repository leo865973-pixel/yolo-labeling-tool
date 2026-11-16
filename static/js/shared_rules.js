/**
 * AI 影像標記工具 — 跨引擎共用規則、常數與智慧局部區塊對齊演算法 (Single Source of Truth)
 * 同時供前端引擎 (web_fs_engine.js / main.js) 與 Python 後端 (core/scanner.py / batch_ops.py) 讀取，
 * 確保雙引擎檢查門檻、支援格式與 ZNCC 智慧對齊邏輯 100% 同步。
 */
(function (root) {
    const RULES = /* YOLO_SHARED_RULES_JSON_START */ {
        "version": "2.1.0",
        "supported_image_exts": [".jpg", ".jpeg", ".png", ".bmp", ".webp"],
        "reserved_class_filenames": ["classes.txt", "predefined_classes.txt", "obj.names"],
        "thresholds": {
            "tiny_box_min_dim": 0.005,
            "oversize_box_max_dim": 1.001,
            "edge_out_of_bounds_tol": 0.002,
            "duplicate_box_iou": 0.88,
            "aspect_ratio_mismatch": 0.015,
            "default_similarity": 0.75,
            "dhash_size": 8,
            "virtual_list_threshold": 150,
            "align_work_size": 320,
            "align_context_pad": 0.15,
            "align_search_radius": 0.10,
            "align_min_confidence": 0.60,
            "align_min_std": 5.0,
            "align_distance_penalty": 0.03
        },
        "sample_classes": ["helmet", "vest", "person", "forklift"]
    } /* YOLO_SHARED_RULES_JSON_END */;

    /**
     * 將影像元素繪製為工作解析度灰階矩陣 (Float32Array)
     */
    function extractGrayGridFromImage(imgEl, workW, workH) {
        if (!imgEl || typeof document === "undefined") return null;
        try {
            const c = document.createElement("canvas");
            c.width = workW;
            c.height = workH;
            const ctx = c.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(imgEl, 0, 0, workW, workH);
            const imgData = ctx.getImageData(0, 0, workW, workH);
            if (!imgData || !imgData.data) return null;
            const rgba = imgData.data;
            const gray = new Float32Array(workW * workH);
            for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
                gray[p] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
            }
            return gray;
        } catch (_) {
            return null;
        }
    }

    /**
     * 由粗到細零均值正規化互相關 (Coarse-to-Fine ZNCC) 局部區塊對齊演算法
     * 對每個標記框獨立在目標影像對應位置周圍搜尋最佳 (dx, dy) 位移並自動微調座標。
     */
    function alignBoxesOnGrayGrids(masterGray, targetGray, workW, workH, boxes) {
        if (!masterGray || !targetGray || !Array.isArray(boxes) || boxes.length === 0) {
            return { boxes: boxes || [], alignedCount: 0, avgConfidence: 0 };
        }
        const cfg = RULES.thresholds;
        const padFactor = 1.0 + (cfg.align_context_pad || 0.15) * 2.0;
        const maxRadX = Math.max(4, Math.round((cfg.align_search_radius || 0.10) * workW));
        const maxRadY = Math.max(4, Math.round((cfg.align_search_radius || 0.10) * workH));
        const maxDist = Math.hypot(maxRadX, maxRadY) || 1;
        const minConf = cfg.align_min_confidence || 0.60;
        const minStd = cfg.align_min_std || 5.0;
        const distPen = cfg.align_distance_penalty || 0.03;

        let alignedCount = 0;
        let confSum = 0;

        const outBoxes = boxes.map((origBox) => {
            const b = { ...origBox };
            const xc = Number(b.xc ?? b.x_center);
            const yc = Number(b.yc ?? b.y_center);
            const w = Number(b.w ?? b.width);
            const h = Number(b.h ?? b.height);

            const padW = Math.min(0.85, w * padFactor);
            const padH = Math.min(0.85, h * padFactor);
            const cx0 = Math.round(xc * workW);
            const cy0 = Math.round(yc * workH);
            const hw = Math.max(4, Math.round((padW * workW) / 2));
            const hh = Math.max(4, Math.round((padH * workH) / 2));

            const tx1 = Math.max(0, cx0 - hw);
            const tx2 = Math.min(workW, cx0 + hw);
            const ty1 = Math.max(0, cy0 - hh);
            const ty2 = Math.min(workH, cy0 + hh);
            const pw = tx2 - tx1;
            const ph = ty2 - ty1;
            const nPix = pw * ph;
            if (pw < 6 || ph < 6 || nPix <= 0) {
                return b;
            }

            // 1. 計算參考模板均值與零均值向量 T0
            let sumT = 0;
            for (let y = ty1; y < ty2; y++) {
                const rowOff = y * workW;
                for (let x = tx1; x < tx2; x++) {
                    sumT += masterGray[rowOff + x];
                }
            }
            const meanT = sumT / nPix;
            const tZero = new Float32Array(nPix);
            let normTSq = 0;
            let k = 0;
            for (let y = ty1; y < ty2; y++) {
                const rowOff = y * workW;
                for (let x = tx1; x < tx2; x++) {
                    const d = masterGray[rowOff + x] - meanT;
                    tZero[k++] = d;
                    normTSq += d * d;
                }
            }
            const stdT = Math.sqrt(normTSq / nPix);
            if (stdT < minStd) {
                // 無紋理純色區塊，不移動座標
                return b;
            }
            const normT = Math.sqrt(normTSq);

            function evalShift(dx, dy) {
                const sx1 = tx1 + dx;
                const sx2 = tx2 + dx;
                const sy1 = ty1 + dy;
                const sy2 = ty2 + dy;
                if (sx1 < 0 || sx2 > workW || sy1 < 0 || sy2 > workH) {
                    return { r: -1, rPen: -1 };
                }
                let sumI = 0;
                for (let y = sy1; y < sy2; y++) {
                    const rowOff = y * workW;
                    for (let x = sx1; x < sx2; x++) {
                        sumI += targetGray[rowOff + x];
                    }
                }
                const meanI = sumI / nPix;
                let dot = 0;
                let normISq = 0;
                let idx = 0;
                for (let y = sy1; y < sy2; y++) {
                    const rowOff = y * workW;
                    for (let x = sx1; x < sx2; x++) {
                        const di = targetGray[rowOff + x] - meanI;
                        dot += tZero[idx++] * di;
                        normISq += di * di;
                    }
                }
                if (normISq <= 1e-6) return { r: 0, rPen: 0 };
                const r = dot / (normT * Math.sqrt(normISq));
                const rPen = r - distPen * (Math.hypot(dx, dy) / maxDist);
                return { r, rPen };
            }

            // 2. 第一階段：粗搜尋 (step = 2px)
            let bestDx = 0;
            let bestDy = 0;
            const zeroEval = evalShift(0, 0);
            let bestR = zeroEval.r;
            let bestRPen = zeroEval.rPen;

            for (let dy = -maxRadY; dy <= maxRadY; dy += 2) {
                for (let dx = -maxRadX; dx <= maxRadX; dx += 2) {
                    const res = evalShift(dx, dy);
                    if (res.rPen > bestRPen) {
                        bestRPen = res.rPen;
                        bestR = res.r;
                        bestDx = dx;
                        bestDy = dy;
                    }
                }
            }

            // 3. 第二階段：精搜尋 (step = 1px)
            const centerDx = bestDx;
            const centerDy = bestDy;
            for (let dy = centerDy - 2; dy <= centerDy + 2; dy++) {
                for (let dx = centerDx - 2; dx <= centerDx + 2; dx++) {
                    const res = evalShift(dx, dy);
                    if (res.rPen > bestRPen) {
                        bestRPen = res.rPen;
                        bestR = res.r;
                        bestDx = dx;
                        bestDy = dy;
                    }
                }
            }

            if (bestR >= minConf) {
                const nextXc = Math.max(w / 2, Math.min(1 - w / 2, Number((xc + bestDx / workW).toFixed(6))));
                const nextYc = Math.max(h / 2, Math.min(1 - h / 2, Number((yc + bestDy / workH).toFixed(6))));
                b.xc = nextXc;
                b.yc = nextYc;
                b.x_center = nextXc;
                b.y_center = nextYc;
                b.w = w;
                b.h = h;
                b.width = w;
                b.height = h;
                b.raw = `${b.class_id} ${nextXc.toFixed(6)} ${nextYc.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}`;
                if (bestDx !== 0 || bestDy !== 0) {
                    alignedCount += 1;
                }
                confSum += bestR;
            }
            return b;
        });

        return {
            boxes: outBoxes,
            alignedCount,
            avgConfidence: boxes.length > 0 ? Number((confSum / boxes.length).toFixed(3)) : 0
        };
    }

    function alignBoxesFromImageElements(masterImgEl, targetImgEl, boxes) {
        if (!masterImgEl || !targetImgEl || !Array.isArray(boxes) || boxes.length === 0) {
            return { boxes: boxes || [], alignedCount: 0, avgConfidence: 0 };
        }
        const workSize = RULES.thresholds.align_work_size || 320;
        const mW = masterImgEl.naturalWidth || masterImgEl.width || 640;
        const mH = masterImgEl.naturalHeight || masterImgEl.height || 480;
        const scale = workSize / Math.max(1, Math.max(mW, mH));
        const workW = Math.max(32, Math.round(mW * scale));
        const workH = Math.max(32, Math.round(mH * scale));

        const masterGray = extractGrayGridFromImage(masterImgEl, workW, workH);
        const targetGray = extractGrayGridFromImage(targetImgEl, workW, workH);
        if (!masterGray || !targetGray) {
            return { boxes: boxes || [], alignedCount: 0, avgConfidence: 0 };
        }
        return alignBoxesOnGrayGrids(masterGray, targetGray, workW, workH, boxes);
    }

    const SMART_ALIGN = {
        extractGrayGridFromImage,
        alignBoxesOnGrayGrids,
        alignBoxesFromImageElements
    };

    if (typeof root !== "undefined") {
        root.YOLO_SHARED_RULES = RULES;
        root.YoloSmartAlign = SMART_ALIGN;
    }
    if (typeof module !== "undefined" && module.exports) {
        module.exports = { RULES, SMART_ALIGN };
    }
})(typeof window !== "undefined" ? window : globalThis);
