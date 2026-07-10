// 番號達人 - Content Script (重構版)
// 功能：自動識別網頁中的番號（如 ABC-123）並提供懸停查詢功能
//
// 架構說明：
// 1. DOM 掃描層：scanNode() 使用 TreeWalker 遍歷文本節點
// 2. 番號識別層：wrapCode() 使用正則匹配並標記高亮
// 3. 特殊處理層：wrapSupCode() 處理跨節點番號（如 nykd<sup>54</sup>）
// 4. 交互層：Tooltip 顯示影片資訊（片名、女優、發行商）
// 5. 性能層：MutationObserver + 節流防抖 + 節點去重
//
// 安全特性：
// - 純 DOM 操作，不使用 innerHTML（防 XSS）
// - 擴展上下文失效檢測（chrome.runtime.id）
// - 輸入驗證（番號格式、文本長度限制）
// - HTML 轉義（escapeHtml 5種特殊字符，OWASP 標準）
//
// 數據流：
// 網頁加載 → DOM 掃描 → 番號標記 → 懸停觸發 → Background 查詢 → Tooltip 展示
(function() {
'use strict';

// ========== 防護機制：防止重複注入 ==========
// 當擴展重新加載時，避免 content script 重複執行導致內存洩漏
if (window.__CODE_EXTENSION_LOADED__) {
  return;
}
window.__CODE_EXTENSION_LOADED__ = true;

// ========== 常數 ==========
// 番號正則表達式：匹配標準格式（如 ABC-123）
// 格式說明：2-8個英文字母 + 連字符(-或－) + 2-5位數字
// 範例：SSIS-001、IPX-123、ABP-4567
// 負向前瞻：確保後面不接著數字或連字符（防止匹配 FC2-PPV-3100012 中的 PPV-31000）
// 負向回顾：確保前面不是多段式番號的一部分（如 FC2-PPV-）
// 移除結尾 \b，讓後面接字母或中文字時也能匹配（如 IPZZ-798RINOA）
const CODE_REGEX = /(?<![A-Za-z]\d{0,3}[-－])\b([A-Za-z]{2,8})[-－](\d{2,5})(?!\d|[-－][A-Za-z])/g;

// 無連字符格式正則：匹配合併格式（如 NYKD54）
// 某些網站會移除連字符，需要額外識別並自動補上
// 範例：NYKD54 → 標準化為 NYKD-54
const CODE_NOHYPHEN_REGEX = /\b([A-Za-z]{2,8})(\d{2,5})(?!\d)/g;

// 預編譯正則表達式（避免重複創建，提升效能）
const PRECOMPILED_REGEX = new RegExp(CODE_REGEX.source, 'gi');
const PRECOMPILED_REGEX_NO_HYPHEN = new RegExp(CODE_NOHYPHEN_REGEX.source, 'gi');
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE', 'IFRAME', 'HEAD', 'svg', 'math']);

// ========== 已知發行商白名單（避免標記網名/航班號）==========
const KNOWN_STUDIOS = new Set([
  // S1 系列
  'SSIS', 'SSNI', 'SNIS', 'SONE', 'OFJE', 'SPS',
  // Idea Pocket
  'IPX', 'IPZ', 'IPTD', 'IPSD', 'IDBD', 'SUPD',
  // Attackers
  'ADN', 'ATID', 'ATKD', 'SHKD', 'RBD', 'JBD', 'SAME', 'SAMA',
  // Madonna
  'JUL', 'JUQ', 'JUC', 'JUY', 'JUSD', 'OBA', 'URE', 'JMD',
  // MOODYZ
  'MIDE', 'MIDD', 'MIDV', 'MIMK', 'MIAA', 'MIFD', 'MIGD', 'MIHA',
  // Das! / DAS
  'DASS', 'DLDSS', 'DSD', 'DMS', 'DMT',
  // Fitch
  'JUFE', 'JUFD', 'JFB', 'FBOS', 'FFT',
  // FALENO / FSDSS
  'FSDSS', 'FCDSS', 'FSVSS',
  // SOD
  'STARS', 'START', 'STSD', 'SDJS', 'SDDE', 'SDMF', 'SDMU',
  // T-Powers / Wanz / Oppai
  'WANZ', 'PPPD', 'PPPE', 'PPBD', 'BOBB', 'BOIN', 'CHRV', 'CHER',
  // NATURAL HIGH
  'NHDTA', 'NHDTB', 'NHDTC', 'NATR', 'NASS', 'NACR', 'NACX',
  // 其他主流
  'ABP', 'ABW', 'EBOD', 'EKDV', 'EYAN', 'SDAB',
  'SKMJ', 'SW', 'HEY', 'HEYZO', 'CARIB', 'CWP', 'CWM',
  '10MUSUME', '1PONDO', 'PACO', 'FC2', 'FC2-PPV', 'SMD', 'SMDV',
  'SQTE', 'T28', 'T-28', 'TMHP', 'TMP', 'VEC', 'VEQ', 'VEO', 'VENU',
  'XVSR', 'REAL', 'CRIM', 'CLUB', 'CCDV', 'CMI', 'CJOD', 'CJVR',
  'DVMM', 'DPMI', 'DPMX', 'GVG', 'GOPJ', 'HND', 'HNDS', 'HNDX',
  'KAWD', 'KATU', 'KBI', 'KBIR', 'KIRE', 'KIRY', 'KUSR', 'KWBD',
  'KWP', 'MIAD', 'MIADG', 'MIAE', 'MIBD', 'MIHB', 'MIMK', 'MIRD',
  'MKMP', 'MIZD', 'MLMM', 'MMDV', 'MMKZ', 'MMNA', 'MMPB', 'MMPD',
  'MMPV', 'MMUS', 'MMYM', 'MOND', 'MOPG', 'MPG', 'MRHP', 'MRSS',
  'MSFH', 'MSHJ', 'MSJN', 'MSPN', 'MTALL', 'MUKC', 'MUKD', 'MVSD',
  'MXGS', 'MXSPS', 'NDRA', 'NDX', 'NKKD', 'NNPJ', 'NPJB', 'NSFS',
  'NTRD', 'NTRDS', 'NTTR', 'OAE', 'OKSN', 'OKS', 'OL', 'ONED', 'ONEZ',
  'ONSG', 'ONS', 'OOMN', 'OPKT', 'ORE', 'OREBMS', 'OREC', 'ORETD',
  'OREX', 'OTIM', 'OVG', 'OVGJ', 'OW', 'PAIS', 'PARATHD', 'PBD',
  'PCHD', 'PCDE', 'PD', 'PDV', 'PED', 'PEDX', 'PGD', 'PIMM', 'PIT',
  'PJD', 'PKJT', 'PKPL', 'PLA', 'PLAT', 'PLMP', 'PM', 'PMEM', 'PMP',
  'PMS', 'PNME', 'POAS', 'PP', 'PPAN', 'PPBD', 'PPBS', 'PPT', 'PPV',
  'PR', 'PRD', 'PRDF', 'PRID', 'PSD', 'PSK', 'PTM', 'PTS', 'PURS',
  'PX', 'PZD', 'QBD', 'R', 'R18', 'RADD', 'RDD', 'RDT', 'REAL',
  'REBDB', 'REBD', 'RKI', 'RMD', 'RMS', 'ROE', 'ROISD',
  'ROJD', 'ROSD', 'ROYD', 'RUKO', 'RVG', 'SAIT', 'SAL', 'SAMA',
  'SAMN', 'SAND', 'SAN', 'SAY', 'SCOP', 'SCPX', 'SCUTE', 'SD',
  'SDAB', 'SDAM', 'SDDE', 'SDEN', 'SDJS', 'SDK', 'SDMF', 'SDMM',
  'SDMT', 'SDMU', 'SDNM', 'SDNT', 'SEI', 'SEN', 'SET', 'SGM',
  'SHIC', 'SHIND', 'SHINKI', 'SHL', 'SHMO', 'SHN', 'SHSN', 'SII',
  'SIS', 'SIV', 'SKD', 'SKMJ', 'SKY', 'SKYHD', 'SM', 'SMA', 'SMBD',
  'SMD', 'SMDV', 'SMES', 'SMIR', 'SMK', 'SMM', 'SMR', 'SMS', 'SN',
  'SNIS', 'SO', 'SOAN', 'SOAV', 'SOE', 'SOU', 'SQTE', 'SRMC', 'SRS',
  'SRYA', 'SS', 'SSDV', 'SSE', 'SSN', 'SSP', 'SSR', 'SSV', 'STAK',
  'STIN', 'STOL', 'STSK', 'STT', 'SUPA', 'SUPD',
  'SUPS', 'SVDVD', 'SVSHA', 'SVVRT', 'SWAC', 'SY',
  'SYK', 'TAB', 'TAMA', 'TAMM', 'TAN', 'TB', 'TBB',
  'TBD', 'TBTB', 'TCH', 'TCD', 'TE', 'TEC', 'TED', 'TEM', 'TERA',
  'TES', 'TFT', 'TG', 'TIKB', 'TIKF', 'TIN', 'TINN', 'TK', 'TKI',
  'TKO', 'TKW', 'TMDI', 'TMD', 'TMEM', 'TMG', 'TMHP', 'TMK', 'TMP',
  'TMS', 'TNS', 'TOK', 'TOKN', 'TORG', 'TPN', 'TRE', 'TRHO', 'TS',
  'TSF', 'TSV', 'TT', 'TTD', 'TTM', 'TUE', 'TUS', 'TYS', 'TZN',
  'UA', 'UB', 'UC', 'UCK', 'UGIR', 'UK', 'UMD', 'UMSO',
  'UPSM', 'UR', 'URE', 'URKK', 'URPS', 'URPW', 'URRT', 'USAG', 'USD',
  'USBA', 'USEN', 'USSR', 'VAGU', 'VAL', 'VANDR', 'VEMA', 'VENU',
  'VENX', 'VEO', 'VEQ', 'VES', 'VICD', 'VIC', 'VDD', 'VRT',
  'VRTM', 'VRTX', 'VSD', 'VSED', 'VSG', 'VSPDS', 'VSPDR',
  'VSRT', 'VSR', 'VSS', 'VTMN', 'WAAA', 'WAWA', 'WANZ', 'WD', 'WKD', 'WPE', 'WPS', 'WRA', 'WSS',
  'WWF', 'WWK', 'X', 'XKG', 'XRW', 'XVSR', 'YAL', 'YAN', 'YC',
  'YDS', 'YMDD', 'YMD', 'YMRK', 'YMSR', 'YMYM', 'YNGR', 'YRH',
  'YSN', 'ZEX', 'ZG', 'ZMEN', 'ZOC', 'ZUKO', 'ZXR', 'ZZ'
]);

// 驗證番號是否為已知發行商
const isKnownStudio = (codeId) => {
  if (!codeId) return false;
  const match = codeId.match(/^([A-Za-z]+)/);
  if (!match) return false;
  const prefix = match[1].toUpperCase();
  return KNOWN_STUDIOS.has(prefix);
};

const TOOLTIP_WIDTH = 240;
const TOOLTIP_HEIGHT = 280;
const MAX_CODE_TAGS = 200; // 每頁最大番號標記數量（效能與體驗平衡）

// ========== 狀態 ==========
let isEnabled = true;
let isHoverEnabled = true;
let isScanning = false;
let tooltip = null;
let currentCode = null;
let currentPageTitle = null; // 從網頁提取的片名
let mutationObserver = null;
let codeTagCount = 0; // 當前頁面已標記番號計數器

// 批量查詢相關狀態
let pendingCodeQueue = []; // 待查詢番號隊列
let verifiedCodeSet = new Set(); // 已驗證存在的番號集合
let isQuerying = false; // 是否正在查詢中

// 調試模式（生產環境設為 false）
const DEBUG_MODE = false;
const debugLog = DEBUG_MODE ? console.log : () => {};

// ========== 工具函數 ==========
// OWASP 標準 HTML 轉義（只處理必要字符）
const escapeHtml = (str) => {
  if (typeof str !== 'string') return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// 驗證番號格式
const validateCodeId = (id) => {
  if (!id || typeof id !== 'string') return false;
  // 更嚴格的番號格式驗證
  const codePattern = /^[A-Za-z]{2,8}[-－]?\d{2,5}$/;
  return codePattern.test(id.trim());
};

// 驗證文本長度
const validateTextLength = (text, maxLength = 200) => {
  return !text || typeof text !== 'string' || text.length > maxLength ? '' : text.trim();
};

// ========== Tooltip ==========
function getTooltip() {
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.className = 'code-tooltip';
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function positionTooltip(x, y) {
  const tip = getTooltip();
  const margin = 12;
  
  // 防止視窗大小為零的邊緣情況
  const winWidth = window.innerWidth || 800;
  const winHeight = window.innerHeight || 600;
  
  let px = x + margin;
  let py = y + margin;

  if (px + TOOLTIP_WIDTH > winWidth) px = x - TOOLTIP_WIDTH - margin;
  if (py + TOOLTIP_HEIGHT > winHeight) py = y - TOOLTIP_HEIGHT - margin;
  if (px < 0) px = margin;
  if (py < 0) py = margin;

  tip.style.left = px + 'px';
  tip.style.top = py + 'px';
}

function showTooltip(codeId, x, y, pageTitle = null) {
  if (!isHoverEnabled) return;
  
  // 驗證輸入
  if (!validateCodeId(codeId)) return;
  
  const tip = getTooltip();
  currentCode = codeId;
  currentPageTitle = validateTextLength(pageTitle);

  // 即時顯示載入狀態 - 使用安全 DOM 操作
  while (tip.firstChild) tip.removeChild(tip.firstChild);
  const header = document.createElement('div');
  header.className = 'code-tooltip-header';
  const idSpan = document.createElement('span');
  idSpan.className = 'code-tooltip-id';
  idSpan.textContent = codeId;
  header.appendChild(idSpan);
  
  const loading = document.createElement('div');
  loading.className = 'code-tooltip-loading';
  
  // 安全地創建載入內容
  const spinner = document.createElement('div');
  spinner.className = 'code-spinner';
  const loadingText = document.createElement('span');
  loadingText.textContent = '查詢中...';
  loading.appendChild(spinner);
  loading.appendChild(loadingText);
  
  tip.appendChild(header);
  tip.appendChild(loading);
  positionTooltip(x, y);
  tip.classList.add('visible');

  // 檢查擴充功能上下文是否有效（在發送請求前）
  let isExtensionValid = false;
  try {
    isExtensionValid = chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    isExtensionValid = false;
  }
  
  if (!isExtensionValid) {
    debugLog('[Code] 擴充功能上下文已失效');
    // 安全地創建錯誤訊息
    while (tip.firstChild) {
      tip.removeChild(tip.firstChild);
    }
    const errorHeader = document.createElement('div');
    errorHeader.className = 'code-tooltip-header';
    const errorIdSpan = document.createElement('span');
    errorIdSpan.className = 'code-tooltip-id';
    errorIdSpan.textContent = codeId;
    errorHeader.appendChild(errorIdSpan);
    
    const errorDiv = document.createElement('div');
    errorDiv.className = 'code-tooltip-error';
    
    const errorIcon = document.createElement('div');
    errorIcon.textContent = '⚠️ 擴充功能需要重新整理';
    errorDiv.appendChild(errorIcon);
    
    const errorHint = document.createElement('div');
    errorHint.style.cssText = 'font-size:12px;color:#888;margin-top:8px;';
    errorHint.textContent = '請重新整理頁面後再試';
    errorDiv.appendChild(errorHint);
    
    tip.appendChild(errorHeader);
    tip.appendChild(errorDiv);
    return;
  }
  
  // 發送請求
  debugLog('[Code] 查詢番號:', codeId);
  
  try {
    chrome.runtime.sendMessage({ type: 'FETCH_CODE', id: codeId }, (res) => {
      // 檢查回調錯誤
      if (chrome.runtime.lastError) {
        const errorMsg = chrome.runtime.lastError.message || '';
        console.error('[Code] 請求錯誤:', errorMsg);
        renderError(tip, codeId);
        return;
      }
      
      if (currentCode !== codeId) return; // 已切換到其他番號
      if (!tip.classList.contains('visible')) return;

      debugLog('[Code] 獲取結果:', res);
      if (res?.success && res.data) {
        renderTooltip(tip, res.data);
      } else {
        debugLog('[Code] 無資料或請求失敗');
        renderError(tip, codeId);
      }
    });
  } catch (e) {
    // 同步拋出異常（Extension context invalidated）
    console.error('[Code] 發送請求異常:', e.message);
    // 使用安全 DOM 操作（清除所有子元素）
    while (tip.firstChild) {
      tip.removeChild(tip.firstChild);
    }
    const errHeader = document.createElement('div');
    errHeader.className = 'code-tooltip-header';
    const errIdSpan = document.createElement('span');
    errIdSpan.className = 'code-tooltip-id';
    errIdSpan.textContent = codeId;
    errHeader.appendChild(errIdSpan);
    
    const errDiv = document.createElement('div');
    errDiv.className = 'code-tooltip-error';
    
    const errMsg1 = document.createElement('div');
    errMsg1.textContent = '⚠️ 擴充功能需要重新整理';
    errDiv.appendChild(errMsg1);
    
    const errMsg2 = document.createElement('div');
    errMsg2.style.cssText = 'font-size:12px;color:#888;margin-top:8px;';
    errMsg2.textContent = '請重新整理頁面後再試';
    errDiv.appendChild(errMsg2);
    
    tip.appendChild(errHeader);
    tip.appendChild(errDiv);
  }
}

function renderTooltip(tip, data) {
  // 調試：查看數據結構（僅在 DEBUG_MODE 時輸出）
  debugLog('[Code] Tooltip 數據:', {
    id: data.id,
    source: data.source,
    pageTitle: currentPageTitle,
    isSearched: data.isSearched
  });
  
  // 準備數據 - 片名優先用資料庫的 data.title（currentPageTitle 是頁面 title，不可靠）
  const id = escapeHtml(data.id || '未知');
  const stripped = (data.title || '').replace(/^[A-Za-z]{2,8}[-－]?\d{2,5}\s*[:：]?\s*/, '').trim();
  const rawTitle = stripped || (data.title && !/^[A-Za-z]{2,8}[-－]?\d{0,5}$/.test(data.title.trim()) ? data.title : '');
  const title = escapeHtml(rawTitle || '未知');
  const studio = escapeHtml(data.studio || '未知');
  
  // 判斷是否為網路搜索回填的數據
  const isSearched = data.isSearched || data.source === 'web-search';
  let isPageFallback = false;
  // 過濾掉與片名相同的 actor（防止解析錯誤把片名塞入 actors）
  const cleanActors = (data.actors || []).filter(a => a && a !== data.title && a.length < 40);
  let actors = cleanActors.length 
    ? cleanActors.map(escapeHtml).join('、') 
    : (isSearched ? '搜尋中...' : '未知');

  // 資料庫沒有女優名時，綜合片名與 DOM 四個來源判定最佳女優名
  if (!cleanActors.length && actors !== '搜尋中...') {
    const pageActors = resolveBestActorName(currentPageTitle, data.actors);
    if (pageActors) {
      actors = escapeHtml(pageActors);
      isPageFallback = true;
    }
  }
  
  // 使用安全 DOM 操作
  while (tip.firstChild) {
    tip.removeChild(tip.firstChild);
  }
  
  // 添加來源標記類別（淡黃色背景表示網路搜索回填或頁面回填）
  if (isSearched || isPageFallback) {
    tip.classList.add('code-tooltip-searched');
  } else {
    tip.classList.remove('code-tooltip-searched');
  }
  
  const header = document.createElement('div');
  header.className = 'code-tooltip-header';
  const idSpan = document.createElement('span');
  idSpan.className = 'code-tooltip-id';
  idSpan.textContent = id;
  header.appendChild(idSpan);
  const sourceSpan = document.createElement('span');
  sourceSpan.className = 'code-tooltip-source';
  sourceSpan.textContent = isSearched 
    ? '🔍 網路搜尋' 
    : (isPageFallback ? '📝 頁面回填' : (data.source || ''));
  header.appendChild(sourceSpan);
  
  const table = document.createElement('div');
  table.className = 'code-tooltip-table';
  
  const row1 = document.createElement('div');
  row1.className = 'code-tooltip-row';
  const titleLabel = document.createElement('span');
  titleLabel.className = 'code-tooltip-label';
  titleLabel.textContent = '片名';
  row1.appendChild(titleLabel);
  const titleSpan = document.createElement('span');
  titleSpan.className = 'code-tooltip-value';
  titleSpan.textContent = title;
  row1.appendChild(titleSpan);
  table.appendChild(row1);
  
  const row2 = document.createElement('div');
  row2.className = 'code-tooltip-row';
  const studioLabel = document.createElement('span');
  studioLabel.className = 'code-tooltip-label';
  studioLabel.textContent = '發行商';
  row2.appendChild(studioLabel);
  const studioSpan = document.createElement('span');
  studioSpan.className = 'code-tooltip-value';
  studioSpan.textContent = studio;
  row2.appendChild(studioSpan);
  table.appendChild(row2);
  
  const row3 = document.createElement('div');
  row3.className = 'code-tooltip-row';
  const actorsLabel = document.createElement('span');
  actorsLabel.className = 'code-tooltip-label';
  actorsLabel.textContent = '女優';
  row3.appendChild(actorsLabel);
  const actorsSpan = document.createElement('span');
  actorsSpan.className = 'code-tooltip-value';
  // 網路搜索或頁面回填時添加淡黃色標記
  if ((isSearched && data.actors?.length) || isPageFallback) {
    actorsSpan.classList.add('code-tooltip-searched-value');
  }
  actorsSpan.textContent = actors;
  row3.appendChild(actorsSpan);
  table.appendChild(row3);
  
  tip.appendChild(header);
  tip.appendChild(table);
}

function renderError(tip, codeId) {
  // 使用安全 DOM 操作（清除所有子元素，避免 innerHTML XSS 風險）
  while (tip.firstChild) {
    tip.removeChild(tip.firstChild);
  }
  const header = document.createElement('div');
  header.className = 'code-tooltip-header';
  const idSpan = document.createElement('span');
  idSpan.className = 'code-tooltip-id';
  idSpan.textContent = codeId;
  header.appendChild(idSpan);
  
  const errorDiv = document.createElement('div');
  errorDiv.className = 'code-tooltip-error';
  const noDataDiv = document.createElement('div');
  noDataDiv.textContent = '暫無資料';
  errorDiv.appendChild(noDataDiv);
  
  tip.appendChild(header);
  tip.appendChild(errorDiv);
}

function hideTooltip() {
  currentCode = null;
  tooltip?.classList.remove('visible');
}

// ========== 批量查詢番號是否存在於資料庫 ==========
/**
 * 批量查詢頁面中發現的番號是否在資料庫中
 * 只有存在的番號才會被標記變色
 */
async function batchQueryCodeDatabase() {
  if (isQuerying || pendingCodeQueue.length === 0) return;
  
  isQuerying = true;
  debugLog('[Code] 開始批量查詢，待查詢數量:', pendingCodeQueue.length);
  
  // 去重：相同番號只查詢一次
  let uniqueCodes = [...new Set(pendingCodeQueue.map(item => item.codeId))];
  pendingCodeQueue = []; // 清空隊列

  // 安全性：限制單批查詢數量，避免惡意頁面塞入大量番號字串
  // 觸發海量對外請求（速率限制 / DoS 防護）。
  const MAX_CODES_PER_BATCH = 50;
  if (uniqueCodes.length > MAX_CODES_PER_BATCH) {
    debugLog('[Code] 番號數量超過上限，截斷至', MAX_CODES_PER_BATCH, '筆');
    uniqueCodes = uniqueCodes.slice(0, MAX_CODES_PER_BATCH);
  }
  
  // 檢查擴展上下文是否有效
  let isExtensionValid = false;
  try {
    isExtensionValid = chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    isExtensionValid = false;
  }
  
  if (!isExtensionValid) {
    debugLog('[Code] 擴充功能上下文無效，跳過批量查詢');
    isQuerying = false;
    return;
  }
  
  // 批量查詢每個番號，分 chunk 避免並發過大
  const chunkSize = 8;
  const chunkDelayMs = 50;
  const chunks = [];
  for (let i = 0; i < uniqueCodes.length; i += chunkSize) {
    chunks.push(uniqueCodes.slice(i, i + chunkSize));
  }

  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i > 0) {
      await new Promise(r => setTimeout(r, chunkDelayMs));
    }
    const chunkResults = await Promise.all(chunk.map(codeId =>
      new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'CHECK_EXISTS', id: codeId }, (res) => {
            if (chrome.runtime.lastError) {
              console.error('[Code] CHECK_EXISTS 失敗:', codeId, chrome.runtime.lastError.message);
              resolve({ codeId, hasTitle: false });
              return;
            }
            // success 為 true 且有片名、發行商、女優名任一項即視為有效番號
            const d = res?.data;
            const hasTitle = res?.success === true && d && (
              (d.title && d.title !== '未知' && d.title !== '') ||
              (d.studio && d.studio !== '未知' && d.studio !== '') ||
              (d.actors && d.actors.length > 0)
            );
            if (res?.success === false) {
              if (res?.error) {
                debugLog('[Code] CHECK_EXISTS 回傳失敗:', codeId, res.error);
              } else {
                debugLog('[Code] CHECK_EXISTS 回傳失敗:', codeId, '(未提供錯誤原因)');
              }
            }
            resolve({ codeId, hasTitle, title: res?.data?.title });
          });
        } catch (e) {
          resolve({ codeId, hasTitle: false });
        }
      })
    ));
    results.push(...chunkResults);
  }
  
  // 將有片名的番號加入已驗證集合
  let verifiedCount = 0;
  for (const result of results) {
    if (result.hasTitle) {
      verifiedCodeSet.add(result.codeId.toUpperCase());
      verifiedCount++;
      debugLog('[Code] 番號有片名:', result.codeId, '-', result.title);
    } else {
      debugLog('[Code] 番號無片名，跳過:', result.codeId);
    }
  }
  
  const failedCount = uniqueCodes.length - verifiedCount;
  debugLog('[Code] 批量查詢完成，總計:', uniqueCodes.length, '成功:', verifiedCount, '失敗:', failedCount);
  
  // 觸發重新掃描來標記已驗證的番號
  if (verifiedCount > 0) {
    applyVerifiedCodeTags();
  }
  
  isQuerying = false;
  
  // 若掃描過程中又有新番號進入隊列，繼續處理
  if (pendingCodeQueue.length > 0) {
    batchQueryCodeDatabase().catch(err => {
      debugLog('[Code] 批量查詢續跑失敗:', err);
    });
  }
}

/**
 * 應用已驗證的番號標記
 * 掃描頁面中所有符合格式的番號，但只標記已在 verifiedCodeSet 中的
 */
function applyVerifiedCodeTags() {
  debugLog('[Code] 應用已驗證番號標記，數量:', verifiedCodeSet.size);
  
  // 使用 TreeWalker 遍歷所有文本節點
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  let node;
  
  while ((node = walker.nextNode())) {
    if (node.textContent.trim()) {
      textNodes.push(node);
    }
  }
  
  // 批次處理文本節點
  for (const textNode of textNodes) {
    wrapCodeVerifiedOnly(textNode);
  }
  
  // 處理 sup 格式
  const supElements = document.querySelectorAll('sup');
  const processedParents = new Set();
  for (const sup of supElements) {
    const parent = sup.parentElement;
    if (!parent || processedParents.has(parent)) continue;
    if (SKIP_TAGS.has(parent.tagName)) continue;
    if (parent.closest?.('.code-tag, .code-tooltip')) continue;
    processedParents.add(parent);
    applySupCodeVerified(parent);
  }
}

// 從文本中提取片名（番號後面的文字）
// 安全限制：最大處理 1000 字符防止 ReDoS
const MAX_TEXT_LENGTH = 1000;

function extractTitleFromText(text, codeId, node) {
  // 輸入驗證與長度限制（防 ReDoS）
  if (!text || typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) {
    text = text ? text.substring(0, MAX_TEXT_LENGTH) : '';
  }
  if (!codeId || typeof codeId !== 'string') return null;
  
  // 安全轉義番號用於正則（只保留字母數字）
  const safeCode = codeId.replace(/[^A-Za-z0-9]/g, '[-－]?');
  
  // 簡化正則：使用字符串索引而非複雜正則
  const codeIndex = text.toUpperCase().indexOf(codeId.toUpperCase());
  if (codeIndex === -1) return null;
  
  // 提取番號後的文本（最多 200 字符）
  const afterCode = text.substring(codeIndex + codeId.length, codeIndex + codeId.length + 200);
  
  // 簡化匹配：查找「」或引號包裹的文本
  const bracketsMatch = afterCode.match(/^[\s]*「([^」]{5,100})」/);
  if (bracketsMatch) return cleanTitle(bracketsMatch[1]);
  
  const quoteMatch = afterCode.match(/^[\s]*"([^"]{5,100})"/);
  if (quoteMatch) return cleanTitle(quoteMatch[1]);
  
  // 查找空格後的中文文本（簡化正則）
  const chineseMatch = afterCode.match(/^[\s]+([\u4e00-\u9fa5][^\n]{4,99})/);
  if (chineseMatch) return cleanTitle(chineseMatch[1]);
  
  // 查找長文本（至少 10 字符）
  const longMatch = afterCode.match(/^[\s]+([^\n]{10,100})/);
  if (longMatch) return cleanTitle(longMatch[1]);
  
  // 輔助函數：清理標題
  function cleanTitle(title) {
    return title
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-–—]+/, '')
      .replace(/\.{3,}$/, '')
      .substring(0, 100);
  }
  
  // 如果從純文本沒找到，嘗試從父元素獲取
  if (node && node.parentElement) {
    const parent = node.parentElement;
    // 檢查父元素的 title 屬性
    if (parent.title && parent.title.length >= 5) {
      return parent.title.substring(0, 100);
    }
    // 檢查父元素的文字內容
    const parentText = parent.textContent;
    if (parentText && parentText.length > codeId.length + 5) {
      // 移除番號後的內容
      const afterCode = parentText.split(codeId)[1];
      if (afterCode && afterCode.trim().length >= 5) {
        return afterCode.trim()
          .replace(/\s+/g, ' ')
          .replace(/^[\s\-–—]+/, '')
          .substring(0, 100);
      }
    }
  }
  
  return null;
}

// 從網頁標題提取女優名稱（常見於片名後接英文/羅馬音或日文女優名）
function extractActorsFromPageTitle(pageTitle) {
  if (!pageTitle || typeof pageTitle !== 'string') return null;

  // 去掉番號前綴，只保留片名部分
  const titlePart = pageTitle.replace(/^[A-Za-z]{2,8}-\d{2,5}\s+/, '').trim();
  if (!titlePart) return null;
  debugLog('[Code] 片名提取女優 - 原始 title:', JSON.stringify(pageTitle), '- 片名部分:', JSON.stringify(titlePart));

  const cjkChars = '\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF\u3400-\u4DBF';
  const cjkClass = `[${cjkChars}]`;

  // 1. 取最後一段 1-3 個英文單字（允許 - 與 '），通常為羅馬音女優名
  const enMatch = pageTitle.match(/([A-Za-z][A-Za-z\s\-'']{0,60}[A-Za-z])\s*$/);
  if (enMatch) {
    const name = enMatch[1].trim();
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length >= 1 && words.length <= 3 && name.length >= 3) {
      debugLog('[Code] 片名提取女優 - 英文結尾:', JSON.stringify(name));
      return { name, source: 'en-end' };
    }
  }

  // 2. 分隔符後的結尾 CJK 名稱（如「...河合明日奈」）—— 最常見於片名末尾夾帶女優名
  const separatorChars = `[\\.\\.。･・~～\\-—_,，\\|/（:：;；!！?？…‥]`;
  const separatorRegex = new RegExp(`${separatorChars}\\s*(${cjkClass}{2,10})\\s*$`, 'u');
  const separatorMatch = titlePart.match(separatorRegex);
  if (separatorMatch) {
    const name = separatorMatch[1].trim();
    if (name.length >= 2 && name.length <= 10) {
      debugLog('[Code] 片名提取女優 - 分隔符結尾:', JSON.stringify(name));
      return { name, source: 'separator-end' };
    }
  }

  // 3. 語義切分：片名開頭的 CJK 名稱後接助詞（如「河合明日奈的異常愛情」→「河合明日奈」）
  const particles = '的|の|を|に|で|と|から|まで|が|は';
  const particleRegex = new RegExp(`^(${cjkClass}{2,8})(${particles})`, 'u');
  const particleMatch = titlePart.match(particleRegex);
  if (particleMatch) {
    const name = particleMatch[1].trim();
    // 過濾明顯非人名的開頭短語（如「搬到隔壁」）
    const nonActorStarts = /^(搬到隔壁|我的|你的|他的|她的|它的|我們的|你們的|他們的|她們的|它們的|這個|那個|這位|那位|隔壁|公司的|學校的|家裡的|房間)/;
    if (!nonActorStarts.test(name)) {
      debugLog('[Code] 片名提取女優 - 助詞切分:', JSON.stringify(name));
      return { name, source: 'particle-start' };
    }
    debugLog('[Code] 片名提取女優 - 助詞切分被過濾:', JSON.stringify(name));
  }

  // 4. 備援：純結尾 CJK 名稱（2-10 個假名/漢字）
  const jpMatch = titlePart.match(new RegExp(`(${cjkClass}{2,10})\\s*$`, 'u'));
  if (jpMatch) {
    const name = jpMatch[1].trim();
    if (name.length >= 2 && name.length <= 10) {
      debugLog('[Code] 片名提取女優 - 純結尾:', JSON.stringify(name));
      return { name, source: 'cjk-end' };
    }
  }

  debugLog('[Code] 片名提取女優 - 無結果');
  return null;
}

// 綜合四個來源判定女優名：資料庫/網路、片名末尾、片名助詞、DOM
// 同時符合多來源者得分更高；平手時優先片名分隔符結尾、資料庫、DOM
function resolveBestActorName(pageTitle, dataActors) {
  const candidates = new Map(); // name -> { score, source }

  function addCandidate(name, score, source) {
    if (!name || typeof name !== 'string') return;
    const key = name.trim();
    if (!key) return;
    const existing = candidates.get(key);
    if (existing) {
      existing.score += score;
    } else {
      candidates.set(key, { score, source });
    }
  }

  // (1) 資料庫/網路（最優先）
  if (dataActors?.length) {
    for (const actor of dataActors) {
      addCandidate(actor, 4, 'database');
    }
  }

  // (2) 片名提取：分隔符/英文結尾可信度較高，助詞/純結尾較低
  const titleResult = extractActorsFromPageTitle(pageTitle);
  if (titleResult) {
    const score = (titleResult.source === 'separator-end' || titleResult.source === 'en-end') ? 3 :
                  (titleResult.source === 'particle-start') ? 1 : 1;
    addCandidate(titleResult.name, score, titleResult.source);
  }

  // (3) 網頁 DOM 同區域
  const domActors = extractActorsFromPageDom();
  if (domActors) {
    for (const name of domActors.split('、')) {
      addCandidate(name, 2, 'dom');
    }
  }

  if (candidates.size === 0) return null;

  // 按得分排序
  const sorted = Array.from(candidates.entries()).sort((a, b) => b[1].score - a[1].score);
  const bestScore = sorted[0][1].score;
  const top = sorted.filter(([_, info]) => info.score === bestScore);

  if (top.length === 1) return top[0][0];

  // 平手時依序偏好：片名分隔符/英文結尾 > 資料庫 > DOM > 其他
  const priority = ['separator-end', 'en-end', 'database', 'dom'];
  for (const p of priority) {
    const found = top.find(([_, info]) => info.source === p);
    if (found) return found[0];
  }
  return top[0][0];
}

// 從網頁 DOM 提取女優名稱（常見標籤：女優、出演者、演员、Cast、Actress 等）
let cachedPageActors = null;
function extractActorsFromPageDom() {
  if (cachedPageActors !== null) return cachedPageActors;

  const labelTexts = ['女優', '出演者', '演员', 'Cast', 'Actress', 'キャスト', '배우'];
  const labelRegex = new RegExp(`^\\s*(${labelTexts.join('|')})[:：]?\\s*$`, 'i');
  // 會被誤認為值的非女優標籤（如關鍵字、分類、標籤）
  // 只要文字以這些標籤開頭（無論後面有沒有值）就視為非女優資料
  const nonActorRegex = /^\s*(關鍵字|关键字|关键词|分類|分类|タグ|tag|tags|ジャンル|genre|categories|カテゴリ)[:：]?/i;
  const isLabel = (text) => labelRegex.test(text);
  const isNonActor = (text) => nonActorRegex.test(text);

  const candidates = [];
  // 限制掃描範圍，避免整頁過重
  const elements = document.querySelectorAll('body *');
  for (const el of elements) {
    if (!isLabel(el.textContent)) continue;

    const parent = el.parentElement;
    if (!parent) continue;

    let value = '';
    let foundLabel = false;
    // 優先：在 label 後面的同層兄弟中找值
    for (const child of Array.from(parent.children)) {
      if (child === el) {
        foundLabel = true;
        continue;
      }
      if (!foundLabel) continue;
      const text = child.textContent.trim();
      if (!text) continue;
      if (isLabel(text) || isNonActor(text)) continue; // 跳過其他標籤
      value = text;
      break;
    }

    // 備援：用 parent 的所有文字，去掉 label 後面的部分
    if (!value) {
      const fullText = parent.textContent.trim();
      const labelText = el.textContent.trim();
      const rest = fullText.replace(labelText, '').trim();
      if (rest && !isLabel(rest) && !isNonActor(rest)) {
        value = rest;
      }
    }

    if (value) {
      candidates.push(value);
      if (candidates.length >= 3) break;
    }
  }

  cachedPageActors = candidates.length ? candidates.join('、') : null;
  debugLog('[Code] 頁面 DOM 提取女優:', cachedPageActors || '(無)');
  return cachedPageActors;
}

// ========== 跨節點 <sup> 番號處理 ==========
// 處理 nykd-<sup>54</sup> 這種數字在上標的情況
// 第一階段：收集番號到隊列
function wrapSupCode(parentEl) {
  const children = Array.from(parentEl.childNodes);
  for (let i = 0; i < children.length - 1; i++) {
    const textNode = children[i];
    const nextNode = children[i + 1];
    
    // 條件：文字節點 + 緊跟的 <sup> 節點
    if (textNode.nodeType !== Node.TEXT_NODE) continue;
    if (!nextNode || nextNode.nodeType !== Node.ELEMENT_NODE) continue;
    if (nextNode.tagName !== 'SUP') continue;
    
    const textPart = textNode.textContent;
    const supPart = nextNode.textContent.trim();
    
    // 數字部分必須是純數字
    if (!/^\d{2,5}$/.test(supPart)) continue;
    
    // 文字部分結尾必須是「字母-」或「字母」（番號前綴）
    const prefixMatch = textPart.match(/([A-Za-z]{2,8})[-－]?\s*$/);
    if (!prefixMatch) continue;
    
    const rawPrefix = prefixMatch[1];
    const prefix = rawPrefix.toUpperCase();
    const suffix = supPart;
    const codeId = `${prefix}-${suffix}`;
    const upperCodeId = codeId.toUpperCase();
    
    // 只添加尚未驗證且不在隊列中的番號
    if (!verifiedCodeSet.has(upperCodeId) && 
        !pendingCodeQueue.some(item => item.codeId === upperCodeId)) {
      pendingCodeQueue.push({
        codeId: upperCodeId,
        textNode: textNode,
        nextNode: nextNode,
        prefixMatch: prefixMatch,
        isSupFormat: true  // 標記為 sup 格式
      });
    }
    
    // 更新索引（跳過剛處理的節點）
    i++;
  }
}

/**
 * applySupCodeVerified: 第二階段 - 只標記已驗證的 sup 格式番號
 */
function applySupCodeVerified(parentEl) {
  // 限制檢查
  if (codeTagCount >= MAX_CODE_TAGS) return;
  
  const children = Array.from(parentEl.childNodes);
  for (let i = 0; i < children.length - 1; i++) {
    const textNode = children[i];
    const nextNode = children[i + 1];
    
    // 條件檢查
    if (textNode.nodeType !== Node.TEXT_NODE) continue;
    if (!nextNode || nextNode.nodeType !== Node.ELEMENT_NODE) continue;
    if (nextNode.tagName !== 'SUP') continue;
    
    const textPart = textNode.textContent;
    const supPart = nextNode.textContent.trim();
    
    if (!/^\d{2,5}$/.test(supPart)) continue;
    
    const prefixMatch = textPart.match(/([A-Za-z]{2,8})[-－]?\s*$/);
    if (!prefixMatch) continue;
    
    const rawPrefix = prefixMatch[1];
    const prefix = rawPrefix.toUpperCase();
    const suffix = supPart;
    const codeId = `${prefix}-${suffix}`.toUpperCase();
    
    // 只處理已驗證的番號
    if (!verifiedCodeSet.has(codeId)) {
      i++;
      continue;
    }
    
    // 建立標籤
    const beforeText = textPart.slice(0, prefixMatch.index);
    
    const container = document.createElement('span');
    container.className = 'code-tag';
    container.dataset.code = codeId;
    container.dataset.normalized = 'true';
    
    const prefixSpan = document.createElement('span');
    prefixSpan.className = 'code-prefix';
    prefixSpan.textContent = `${prefix}-`;
    
    const suffixSpan = document.createElement('span');
    suffixSpan.className = 'code-suffix';
    suffixSpan.textContent = suffix;
    
    container.appendChild(prefixSpan);
    container.appendChild(suffixSpan);
    
    // 替換節點
    textNode.textContent = beforeText;
    nextNode.parentNode.removeChild(nextNode);
    textNode.parentNode.insertBefore(container, textNode.nextSibling);
    
    codeTagCount++;
    i++;
    
    if (codeTagCount >= MAX_CODE_TAGS) break;
  }
}

// ========== DOM 掃描 (重構) ==========
/**
 * wrapCode: 核心番號識別與標記函數
 *
 * 處理流程：
 * 1. 驗證節點有效性（避免操作已被移除的節點）
 * 2. 正則匹配兩種番號格式（標準格式 + 無連字符格式）
 * 3. 去重處理：無連字符匹配需排除與標準格式重疊的位置
 * 4. 合併排序：依照文本出現順序處理所有匹配
 * 5. DOM 重構：用 DocumentFragment 批次替換，減少重繪
 * 6. 標記創建：為每個番號創建 .code-tag 元素，包含片名數據
 *
 * 性能優化點：
 * - 預編譯正則表達式避免重複創建
 * - DocumentFragment 批次 DOM 操作
 * - lastIndex 重置防止正則狀態污染
 */
/**
 * wrapCode: 第一階段 - 收集番號到待查詢隊列
 * 不再立即標記，而是將發現的番號加入 pendingCodeQueue
 */
function wrapCode(textNode) {
  // 節點有效性檢查：確保節點仍在 DOM 中且未被其他操作修改
  const parent = textNode.parentNode;
  if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return;

  // 防護：避免處理已標記的元素內部（防止遞歸處理）
  if (parent.closest?.('.code-tag')) return;
  // 防護：避免處理可編輯區域（防止干擾用戶輸入）
  if (parent.isContentEditable || parent.closest?.('[contenteditable="true"]')) return;

  const text = textNode.textContent;

  // 重置正則狀態（global 正則的 lastIndex 會在 match 後改變，需手動重置）
  PRECOMPILED_REGEX.lastIndex = 0;
  PRECOMPILED_REGEX_NO_HYPHEN.lastIndex = 0;

  // 步驟 1：匹配標準格式（如 ABC-123）
  const withHyphen = [...text.matchAll(PRECOMPILED_REGEX)]
    .map(m => ({ match: m, addHyphen: false }));

  // 步驟 2：計算標準格式已佔用的字符位置（用於去重）
  const hyphenPositions = new Set(withHyphen.flatMap(({ match: m }) => {
    const positions = [];
    for (let i = m.index; i < m.index + m[0].length; i++) positions.push(i);
    return positions;
  }));

  // 步驟 3：匹配無連字符格式，但排除與標準格式重疊的匹配
  const withoutHyphen = [...text.matchAll(PRECOMPILED_REGEX_NO_HYPHEN)]
    .filter(m => !hyphenPositions.has(m.index))
    .map(m => ({ match: m, addHyphen: true }));

  // 步驟 4：合併兩種匹配並依照文本位置排序
  const allMatchObjs = [...withHyphen, ...withoutHyphen]
    .sort((a, b) => a.match.index - b.match.index);
  
  // 沒有匹配則返回
  if (allMatchObjs.length === 0) return;

  // 將發現的番號加入待查詢隊列
  for (const matchObj of allMatchObjs) {
    const { match, addHyphen } = matchObj;
    const [full, rawPrefix, suffix] = match;
    const prefix = rawPrefix.toUpperCase();
    const codeId = `${prefix}-${suffix}`;
    
    // 只添加尚未驗證且不在隊列中的番號
    const upperCodeId = codeId.toUpperCase();
    if (!verifiedCodeSet.has(upperCodeId) && 
        !pendingCodeQueue.some(item => item.codeId === upperCodeId)) {
      pendingCodeQueue.push({
        codeId: upperCodeId,
        textNode: textNode,
        match: match,
        addHyphen: addHyphen
      });
    }
  }
}

/**
 * wrapCodeVerifiedOnly: 第二階段 - 只標記已驗證的番號
 * 只標記已在 verifiedCodeSet 中的番號
 */
function wrapCodeVerifiedOnly(textNode) {
  // 節點有效性檢查
  const parent = textNode.parentNode;
  if (!parent || parent.nodeType !== Node.ELEMENT_NODE) return;
  if (parent.closest?.('.code-tag')) return;
  if (parent.isContentEditable || parent.closest?.('[contenteditable="true"]')) return;
  
  // 限制檢查
  if (codeTagCount >= MAX_CODE_TAGS) return;

  const text = textNode.textContent;

  // 重置正則狀態
  PRECOMPILED_REGEX.lastIndex = 0;
  PRECOMPILED_REGEX_NO_HYPHEN.lastIndex = 0;

  // 匹配標準格式
  const withHyphen = [...text.matchAll(PRECOMPILED_REGEX)]
    .map(m => ({ match: m, addHyphen: false }));

  // 計算標準格式已佔用的字符位置
  const hyphenPositions = new Set(withHyphen.flatMap(({ match: m }) => {
    const positions = [];
    for (let i = m.index; i < m.index + m[0].length; i++) positions.push(i);
    return positions;
  }));

  // 匹配無連字符格式，但排除與標準格式重疊的
  const withoutHyphen = [...text.matchAll(PRECOMPILED_REGEX_NO_HYPHEN)]
    .filter(m => !hyphenPositions.has(m.index))
    .map(m => ({ match: m, addHyphen: true }));

  // 合併兩種匹配
  const allMatchObjs = [...withHyphen, ...withoutHyphen]
    .sort((a, b) => a.match.index - b.match.index);
  
  // 過濾：只保留已驗證的番號
  const verifiedMatches = allMatchObjs.filter(({ match }) => {
    const [full, rawPrefix, suffix] = match;
    const prefix = rawPrefix.toUpperCase();
    const codeId = `${prefix}-${suffix}`.toUpperCase();
    return verifiedCodeSet.has(codeId);
  });
  
  if (verifiedMatches.length === 0) return;

  const frag = document.createDocumentFragment();
  let lastIndex = 0;

  // 處理每個已驗證的匹配
  for (const matchObj of verifiedMatches) {
    const { match, addHyphen } = matchObj;
    const [full, rawPrefix, suffix] = match;
    const prefix = rawPrefix.toUpperCase();
    const start = match.index;

    if (start > lastIndex) {
      frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
    }

    // Pornhub 風格標記
    const container = document.createElement('span');
    container.className = 'code-tag';
    container.dataset.code = `${prefix}-${suffix}`;
    if (addHyphen) container.dataset.normalized = 'true';
    
    // 提取片名
    const title = extractTitleFromText(text, `${prefix}-${suffix}`, textNode);
    if (title) {
      container.dataset.title = title;
    }
    
    const prefixSpan = document.createElement('span');
    prefixSpan.className = 'code-prefix';
    prefixSpan.textContent = `${prefix}-`;
    
    const suffixSpan = document.createElement('span');
    suffixSpan.className = 'code-suffix';
    suffixSpan.textContent = suffix;
    
    container.appendChild(prefixSpan);
    container.appendChild(suffixSpan);
    frag.appendChild(container);
    
    codeTagCount++;
    lastIndex = start + full.length;
  }

  if (lastIndex < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  // 最後檢查 parent 仍存在
  if (textNode.parentNode === parent) {
    parent.replaceChild(frag, textNode);
  }
}

// 迭代器掃描，先收集再處理（避免 DOM 修改影響迭代）
function scanNode(node) {
  // 限制檢查：超過最大標記數量則停止掃描
  if (codeTagCount >= MAX_CODE_TAGS) {
    return;
  }
  
  if (node.nodeType === Node.TEXT_NODE) {
    if (node.textContent.trim()) wrapCode(node);
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;
  if (SKIP_TAGS.has(node.tagName)) return;
  if (node.closest?.('.code-tag, .code-tooltip')) return;

  // 先掃描所有元素，處理跨節點的 <sup> 番號（如 nykd-<sup>54</sup>）
  // 優化：只處理包含 <sup> 的父元素，減少不必要的查詢
  const supElements = node.querySelectorAll('sup');
  const processedParents = new Set();
  for (const sup of supElements) {
    const parent = sup.parentElement;
    if (!parent || processedParents.has(parent)) continue;
    if (SKIP_TAGS.has(parent.tagName)) continue;
    if (parent.closest?.('.code-tag, .code-tooltip')) continue;
    processedParents.add(parent);
    wrapSupCode(parent);
  }

  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null, false);
  const textNodes = [];
  let textNode;
  
  // 先收集所有文字節點
  while ((textNode = walker.nextNode())) {
    if (textNode.textContent.trim()) {
      textNodes.push(textNode);
    }
  }
  
  // 再批次處理（避免迭代中修改 DOM 導致節點被跳過）
  for (const tn of textNodes) {
    // 限制檢查：超過最大標記數量則停止處理
    if (codeTagCount >= MAX_CODE_TAGS) {
      break;
    }
    wrapCode(tn);
  }
}

function scanWithLock(node) {
  if (isScanning) return;
  isScanning = true;
  try { scanNode(node); } finally { isScanning = false; }
}

// ========== 事件處理 ==========
// 單一事件監聽，簡化邏輯
document.addEventListener('mouseover', (e) => {
  const target = e.target.closest('.code-tag');
  if (!target) return;

  const codeId = target.dataset.code;
  const pageTitle = target.dataset.title; // 從網頁提取的片名
  if (currentCode === codeId) return;

  showTooltip(codeId, e.clientX, e.clientY, pageTitle);
}, { passive: true });

document.addEventListener('mousemove', (e) => {
  if (tooltip?.classList.contains('visible')) {
    positionTooltip(e.clientX, e.clientY);
  }
}, { passive: true });

document.addEventListener('mouseout', (e) => {
  if (e.target.closest('.code-tag') && !e.relatedTarget?.closest('.code-tooltip')) {
    hideTooltip();
  }
}, { passive: true });

// 點擊番號複製到剪貼簿（帶權限檢查）
document.addEventListener('click', async (e) => {
  const tag = e.target.closest('.code-tag');
  if (!tag) return;

  try {
    // 檢查剪貼簿權限
    if (!navigator.clipboard) {
      console.warn('Clipboard API not available');
      return;
    }
    
    await navigator.clipboard.writeText(tag.dataset.code);
    tag.classList.add('copied');
    setTimeout(() => tag.classList.remove('copied'), 800);
  } catch (err) {
    console.warn('Copy failed:', err);
    // 失敗時顯示提示而非靜默失敗
    tag.style.textDecoration = 'line-through';
    setTimeout(() => tag.style.textDecoration = '', 300);
  }
});

// ========== 初始化 ==========
/**
 * 性能優化機制說明：
 *
 * 1. 節流 (Throttle)：SCAN_THROTTLE = 100ms
 *    - 限制最短掃描間隔，避免高頻 DOM 變化觸發過多掃描
 *    - 特別針對無限滾動、快速輸入等場景
 *
 * 2. 防抖 (Debounce)：setTimeout 100ms
 *    - 收集一批 DOM 變化後統一處理，減少重複掃描
 *    - 新變化到達時重置計時器，確保處理最新狀態
 *
 * 3. 節點去重 (Deduplication)：
 *    - 問題：父節點和子節點同時變化會導致重複掃描
 *    - 解決：檢查祖先鏈，只保留最頂層節點
 *    - 複雜度：O(n) 祖先檢查替代 O(n²) 巢狀比較
 *
 * 4. 掃描鎖 (Scan Lock)：isScanning
 *    - 防止 mutation 回調和手動掃描並發執行
 *    - 避免 Race condition 導致的節點丟失
 */
let scanQueue = [];        // 待處理節點佇列
let scanTimeout = null;    // 防抖計時器
let lastScanTime = 0;      // 上次掃描時間戳
const SCAN_THROTTLE = 100; // 節流間隔：100ms

/**
 * initMutationObserver: 初始化 DOM 變化監聽
 *
 * 處理流程：
 * 1. Mutation 回調觸發
 * 2. 節流檢查（距上次掃描是否超過 100ms）
 * 3. 收集變化節點到佇列（排除已由本擴展創建的元素）
 * 4. 防抖等待（100ms 內無新變化則執行）
 * 5. 節點去重（保留最頂層父節點）
 * 6. 斷開觀察器 → 批次掃描 → 重新連接觀察器
 *
 * 注意：斷開觀察器是為了防止掃描過程中觸發新的 mutation，導致無限循環
 */
function initMutationObserver() {
  mutationObserver = new MutationObserver((mutations) => {
    // 防護：掃描進行中不處理新變化（避免並發修改）
    if (isScanning) {
      // 掃描中仍收集節點，稍後處理
      queueMutations(mutations);
      return;
    }

    // 收集變化節點到佇列
    queueMutations(mutations);

    // 節流控制：計算延遲時間
    const now = Date.now();
    const timeSinceLastScan = now - lastScanTime;
    const delay = timeSinceLastScan < SCAN_THROTTLE ? SCAN_THROTTLE - timeSinceLastScan : 0;

    // 防抖處理（帶節流）
    clearTimeout(scanTimeout);
    scanTimeout = setTimeout(() => {
      if (!scanQueue.length || isScanning) return;
      
      lastScanTime = Date.now();
      processScanQueue();
    }, Math.max(delay, 100)); // 至少 100ms 防抖
  });

  mutationObserver.observe(document.body, { childList: true, subtree: true });
}

// 輔助函數：將變化收集到佇列
function queueMutations(mutations) {
  for (const mutation of mutations) {
    for (const node of mutation.addedNodes) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (!node.closest?.('.code-tag, .code-tooltip')) {
          scanQueue.push(node);
        }
      } else if (node.nodeType === Node.TEXT_NODE && node.parentNode) {
        const parent = node.parentNode;
        if (parent.nodeType === Node.ELEMENT_NODE &&
            !parent.closest?.('.code-tag, .code-tooltip')) {
          scanQueue.push(node);
        }
      }
    }
  }
}

// 輔助函數：處理掃描佇列
function processScanQueue() {
  // 優化去重：只保留最高層級節點
  const nodeSet = new Set(scanQueue);
  const uniqueNodes = [];
  
  for (const node of scanQueue) {
    let parent = node.parentNode;
    let isContained = false;
    while (parent) {
      if (nodeSet.has(parent)) {
        isContained = true;
        break;
      }
      parent = parent.parentNode;
    }
    if (!isContained) uniqueNodes.push(node);
  }
  scanQueue = [];

  // 斷開觀察器防止無限循環
  mutationObserver?.disconnect();
  uniqueNodes.forEach(n => scanWithLock(n));
  mutationObserver?.observe(document.body, { childList: true, subtree: true });
  
  // 掃描後若有新番號，觸發批量查詢
  if (pendingCodeQueue.length > 0) {
    batchQueryCodeDatabase().catch(err => {
      debugLog('[Code] 批量查詢失敗:', err);
    });
  }
}

/**
 * init: 擴展初始化入口
 *
 * 初始化流程：
 * 1. 檢查擴展上下文有效性（chrome.runtime.id）
 *    - 有效：從 chrome.storage 讀取設置，監聽設置變化
 *    - 無效：使用預設值（isEnabled=true, isHoverEnabled=true）
 *
 * 2. 執行初始掃描（scanWithLock）
 *    - 掃描整個 document.body
 *    - 識別並標記所有番號
 *
 * 3. 啟動 MutationObserver
 *    - 監聽後續 DOM 變化
 *    - 處理動態加載內容（如無限滾動）
 *
 * 錯誤處理策略（多層回退）：
 * - 第一層：chrome.runtime 訪問異常 → 使用預設值
 * - 第二層：storage 讀取失敗 → 使用預設值
 * - 第三層：初始掃描失敗 → 記錄錯誤，但不中斷整個流程
 * - 第四層：observer 啟動失敗 → 記錄錯誤，基本功能仍可運作
 *
 * 資源清理：
 * - beforeunload 事件斷開 observer
 * - 清除防抖計時器
 * - 移除 storage 監聽器
 */
let delayedRescanTimeout = null; // 延遲重新掃描計時器

function init() {
  // 重置標記計數器（確保每次初始化從零開始）
  codeTagCount = 0;
  
  debugLog('[Code] 初始化開始，頁面:', window.location.href);
  
  // ========== 步驟 1：檢查擴展上下文有效性 ==========
  // 當擴展被重新加載或更新時，舊的 content script 會失去與 background 的連接
  // 此時 chrome.runtime.id 會變為 undefined，訪問任何 chrome API 都會拋錯
  let isExtensionValid = false;
  try {
    isExtensionValid = chrome.runtime && !!chrome.runtime.id;
  } catch (e) {
    isExtensionValid = false;
  }

  // ========== 情景 A：擴展上下文無效，使用預設值 ==========
  if (!isExtensionValid) {
    debugLog('[Code] 擴充功能上下文無效，使用預設值初始化');
    isEnabled = true;        // 默認啟用
    isHoverEnabled = true;   // 默認啟用懸停

    try {
      scanWithLock(document.body);  // 嘗試執行初始掃描
      initMutationObserver();        // 嘗試啟動 observer
    } catch (err) {
      console.error('[Code] Fallback initialization failed:', err);
    }
    return;  // 不使用 storage，直接返回
  }

  // ========== 情景 B：擴展上下文有效，正常初始化 ==========
  try {
    // 從 chrome.storage 讀取設置
    chrome.storage.local.get(['codeEnabled', 'codeHover'], (res) => {
      // 檢查回調時的錯誤（可能上下文在此時失效）
      let hasError = false;
      try {
        hasError = !!chrome.runtime.lastError;
      } catch (e) {
        hasError = true;
      }

      if (hasError) {
        debugLog('[Code] Failed to read settings');
        isEnabled = true;      // 讀取失敗使用預設值
        isHoverEnabled = true;
      } else {
        isEnabled = res.codeEnabled !== false;    // 默認 true（除非明確設為 false）
        isHoverEnabled = res.codeHover !== false; // 默認 true
      }

      // 如果被禁用，不執行掃描
      if (!isEnabled) return;

      // 執行初始掃描（第一階段：收集番號到隊列）
      try {
        scanWithLock(document.body);
        
        // 延遲執行批量查詢（第二階段）
        setTimeout(() => {
          batchQueryCodeDatabase().then(() => {
            debugLog('[Code] 初始批量查詢完成');
          }).catch(err => {
            debugLog('[Code] 批量查詢失敗:', err);
          });
        }, 100); // 延遲 100ms 確保頁面穩定
        
        initMutationObserver();
        
        // 延遲重新掃描：處理慢載入或動態渲染的內容
        delayedRescanTimeout = setTimeout(() => {
          if (!isEnabled) return;
          debugLog('[Code] 執行延遲重新掃描，待查詢:', pendingCodeQueue.length, '已驗證:', verifiedCodeSet.size);
          scanWithLock(document.body);
          if (pendingCodeQueue.length > 0) {
            batchQueryCodeDatabase().catch(err => {
              debugLog('[Code] 延遲批量查詢失敗:', err);
            });
          }
        }, 2000);
      } catch (err) {
        console.error('[Code] Initialization failed:', err);
      }
    });

    // ========== 監聽設置變更（實時響應彈出頁面的開關操作）==========
    const storageListener = (changes) => {
      try {
        if (changes.codeEnabled) isEnabled = changes.codeEnabled.newValue !== false;
        if (changes.codeHover) {
          isHoverEnabled = changes.codeHover.newValue !== false;
          if (!isHoverEnabled) hideTooltip();  // 關閉懸停時立即隱藏 tooltip
        }
      } catch (e) {
        debugLog('[Code] Storage listener error:', e.message);
      }
    };
    chrome.storage.onChanged.addListener(storageListener);

    // ========== 頁面卸載時清理資源（防止內存洩漏）==========
    window.addEventListener('beforeunload', () => {
      if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
      }
      if (scanTimeout) {
        clearTimeout(scanTimeout);
        scanTimeout = null;
      }
      if (delayedRescanTimeout) {
        clearTimeout(delayedRescanTimeout);
        delayedRescanTimeout = null;
      }
      try {
        chrome.storage.onChanged.removeListener(storageListener);
      } catch (e) {
        // 忽略清理錯誤（可能上下文已失效）
      }
    });

  } catch (e) {
    // ========== 最終回退：所有初始化嘗試都失敗 ==========
    debugLog('[Code] Extension context error during init:', e.message);
    isEnabled = true;
    isHoverEnabled = true;
    try {
      scanWithLock(document.body);
      
      // 延遲執行批量查詢
      setTimeout(() => {
        batchQueryCodeDatabase().catch(err => {
          debugLog('[Code] Fallback 批量查詢失敗:', err);
        });
      }, 100);
      
      initMutationObserver();
      
      // Fallback 也加入延遲重新掃描
      delayedRescanTimeout = setTimeout(() => {
        if (!isEnabled) return;
        debugLog('[Code] Fallback 延遲重新掃描，待查詢:', pendingCodeQueue.length, '已驗證:', verifiedCodeSet.size);
        scanWithLock(document.body);
        if (pendingCodeQueue.length > 0) {
          batchQueryCodeDatabase().catch(err => {
            debugLog('[Code] Fallback 延遲批量查詢失敗:', err);
          });
        }
      }, 2000);
    } catch (scanErr) {
      debugLog('[Code] Final fallback failed:', scanErr.message);
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})(); // IIFE 結束
