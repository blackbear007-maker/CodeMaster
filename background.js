// 番號達人 - Service Worker (Background Script)
// 功能：處理番號查詢請求，聚合多數據源，管理本地快取
//
// 架構說明：
// 1. 訊息處理層：chrome.runtime.onMessage 監聽 content script 請求
// 2. 數據源層：多個 fetch 函數（JAVLibrary/JAVDB/JAVBUS/MGStage）
// 3. 數據合併層：fetchCodeInfo 合併多源數據，優先補充缺失欄位
// 4. 快取層：LRU 策略 + 配額管理 + 圖片 base64 快取
// 5. 工具層：HTML 解析、圖片下載、請求去重
//
// 數據流：
// Content Script 請求 → 快取檢查 → 多源查詢 → 數據合併 → 回傳結果 → 存入快取
//
// 多源策略（優先級）：
// 1. JAVLibrary (日本官方) - 最準確的女優和封面
// 2. JAVDB (中文站) - 中文片名和詳細資訊
// 3. JAVBUS (中文站) - 備份數據源
// 4. MGStage (日本官方) - 特定片商補充
//
// 快取策略：
// - TTL: 3天（減少存儲壓力）
// - LRU: 超過 200 條時刪除最舊
// - 配額管理：超過 5MB 自動清理
// - 圖片獨立：最多 30 張，5MB 大小限制
(function() {
'use strict';

// ========== 調試配置 ==========
// DEBUG_MODE = true 時輸出詳細日誌，生產環境設為 false
const DEBUG_MODE = false;
const debugLog = DEBUG_MODE ? console.log : () => {};

const CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 天快取（減少快取時間避免記憶體累積）
const MAX_CACHE_ENTRIES = 200;            // 減少數據條數，為圖片預留空間
const REQUEST_TIMEOUT = 10000;            // 10 秒超時
const MAX_IMAGE_CACHE = 30;               // 最多快取 30 張圖片（減少記憶體使用）
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;   // 最大圖片大小 5MB

// ========== 智能本地快取（含圖片 base64 快取）==========
/**
 * 快取架構說明：
 *
 * 存儲結構：
 * - 數據快取：{ key: "code_ABC123", value: { data: {...}, ts: timestamp } }
 * - 圖片快取：{ key: "code_ABC123_img", value: { data: "base64...", ts: timestamp } }
 *
 * 淘汰策略（LRU - Least Recently Used）：
 * 1. 當新數據寫入時檢查總數是否超過 MAX_CACHE_ENTRIES
 * 2. 超過時刪除 timestamp 最早的條目（包括其圖片快取）
 * 3. 時間複雜度：O(n log n) 排序找出最舊條目
 *
 * 配額管理：
 * - chrome.storage.local 配額約 10MB（含所有擴展）
 * - 監聽 QuotaExceededError，觸發時清除 50% 最舊快取
 * - 單張圖片限制 5MB，防止大圖片佔滿配額
 *
 * 圖片獨立管理：
 * - 數據和圖片分開存儲，便於獨立清理
 * - 圖片有獨立的數量限制（MAX_IMAGE_CACHE = 30）
 * - 圖片有獨立的大小限制（MAX_IMAGE_SIZE = 5MB）
 */
const cache = {
  /**
   * 獲取快取數據
   * @param {string} key - 快取鍵名（如 "code_ABC123"）
   * @returns {Promise<any|null>} - 返回快取數據或 null（已過期或不存在）
   */
  async get(key) {
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    // 檢查 TTL（Time To Live）：超過 3 天視為過期
    return entry && Date.now() - entry.ts < CACHE_TTL ? entry.data : null;
  },

  /**
   * 設置快取數據（自動 LRU 淘汰和配額管理）
   * @param {string} key - 快取鍵名
   * @param {any} data - 要存儲的數據
   */
  async set(key, data) {
    try {
      // 檢查鍵是否已存在（避免不必要的 LRU 清理）
      const existing = await chrome.storage.local.get(key);
      const isNewKey = !existing[key];
      
      // 只有新增鍵且可能超限時才執行 LRU 清理
      if (isNewKey) {
        // 使用計數器估算（比讀取全部快取更高效）
        const countResult = await chrome.storage.local.get('code_cache_count');
        let cacheCount = countResult.code_cache_count || 0;
        
        if (cacheCount >= MAX_CACHE_ENTRIES) {
          // 需要清理時才讀取所有鍵
          const all = await chrome.storage.local.get(null);
          const codeKeys = Object.keys(all).filter(k => k.startsWith('code_') && !k.endsWith('_img'));
          
          if (codeKeys.length >= MAX_CACHE_ENTRIES) {
            const oldest = codeKeys
              .map(k => ({ k, ts: all[k]?.ts || 0 }))
              .sort((a, b) => a.ts - b.ts)[0];
            if (oldest) {
              await chrome.storage.local.remove([oldest.k, oldest.k + '_img']);
              cacheCount--;
            }
          }
        }
        
        // 更新計數器
        await chrome.storage.local.set({ code_cache_count: cacheCount + 1 });
      }
      
      await chrome.storage.local.set({ [key]: { data, ts: Date.now() } });
    } catch (err) {
      // 配額超限時，清除 30% 最舊快取
      if (err.message?.includes('QUOTA') || err.name === 'QuotaExceededError') {
        console.warn('Storage quota exceeded, clearing old cache...');
        const all = await chrome.storage.local.get(null);
        const codeKeys = Object.keys(all)
          .filter(k => k.startsWith('code_') && !k.endsWith('_img'))
          .sort((a, b) => (all[a]?.ts || 0) - (all[b]?.ts || 0));
        
        // 刪除最舊的 30%（更溫和）
        const toDelete = codeKeys.slice(0, Math.ceil(codeKeys.length * 0.3));
        const imgKeys = toDelete.map(k => k + '_img');
        await chrome.storage.local.remove([...toDelete, ...imgKeys]);
        await chrome.storage.local.set({ code_cache_count: codeKeys.length - toDelete.length });
        
        // 重試
        await chrome.storage.local.set({ [key]: { data, ts: Date.now() } });
      } else {
        throw err;
      }
    }
  },
  
  // 獲取圖片快取
  async getImage(key) {
    const result = await chrome.storage.local.get(key + '_img');
    const entry = result[key + '_img'];
    return entry && Date.now() - entry.ts < CACHE_TTL ? entry.data : null;
  },
  
  // 設置圖片快取（base64）
  async setImage(key, base64Data) {
    try {
      // 檢查圖片大小
      if (base64Data && base64Data.length > MAX_IMAGE_SIZE) {
        console.warn('[Cache] 圖片過大，跳過快取:', key);
        return;
      }
      
      // 檢查圖片快取數量
      const all = await chrome.storage.local.get(null);
      const imageKeys = Object.keys(all).filter(k => k.endsWith('_img'));
      
      // 如果圖片快取太多，刪除最舊的
      if (imageKeys.length >= MAX_IMAGE_CACHE) {
        const oldest = imageKeys
          .map(k => ({ k, ts: all[k]?.ts || 0 }))
          .sort((a, b) => a.ts - b.ts)[0];
        if (oldest) await chrome.storage.local.remove(oldest.k);
      }
      
      await chrome.storage.local.set({ [key + '_img']: { data: base64Data, ts: Date.now() } });
      debugLog('[Cache] 圖片快取成功:', key);
    } catch (e) {
      console.warn('[Cache] 圖片快取失敗:', e.message);
      // 如果快取失敗，嘗試清理舊快取後重試
      if (e.message?.includes('QUOTA') || e.name === 'QuotaExceededError') {
        await this.clearOldImages();
        try {
          await chrome.storage.local.set({ [key + '_img']: { data: base64Data, ts: Date.now() } });
        } catch (retryErr) {
          console.warn('[Cache] 重試快取仍然失敗:', retryErr.message);
        }
      }
    }
  },
  
  // 清理舊圖片快取
  async clearOldImages() {
    try {
      const all = await chrome.storage.local.get(null);
      const imageKeys = Object.keys(all).filter(k => k.endsWith('_img'));
      
      // 刪除最舊的一半圖片
      const sortedImages = imageKeys
        .map(k => ({ k, ts: all[k]?.ts || 0 }))
        .sort((a, b) => a.ts - b.ts);
      
      const toDelete = sortedImages.slice(0, Math.floor(sortedImages.length / 2));
      if (toDelete.length > 0) {
        await chrome.storage.local.remove(toDelete.map(item => item.k));
        debugLog('[Cache] 清理了', toDelete.length, '個舊圖片快取');
      }
    } catch (e) {
      console.warn('[Cache] 清理舊圖片失敗:', e.message);
    }
  }
};

// 判斷是否為超時錯誤
function isTimeoutError(e) {
  return e?.message === 'Request timeout';
}

// ========== 帶超時的 fetch ==========
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (e) {
    clearTimeout(timeout);
    if (e?.name === 'AbortError') {
      throw new Error('Request timeout');
    }
    throw e;
  }
}

// ========== HTML 解析工具（Regex 版本，Service Worker 兼容）==========
const extractCover = (html, patterns, baseUrl = '') => {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      let url = match[1];
      // 清理 URL
      url = url.replace(/&amp;/g, '&').trim();
      
      // 處理不同類型的 URL
      if (url.startsWith('//')) {
        // 協議相對 URL
        url = 'https:' + url;
      } else if (url.startsWith('/')) {
        // 絕對路徑，需要 baseUrl
        if (baseUrl) {
          url = baseUrl.replace(/\/$/, '') + url;
        } else {
          url = 'https:' + url; // 預設行為
        }
      } else if (!url.startsWith('http')) {
        // 相對路徑（不帶/）
        if (baseUrl) {
          url = baseUrl + url;
        }
      }
      
      // 確保是有效圖片 URL
      if (/\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url)) {
        return url;
      }
    }
  }
  return null;
};

// 圖片大小檢查（Service Worker 版本）
async function checkImageSize(blob) {
  // 在 Service Worker 中，我們只能檢查 blob 大小
  const sizeKB = blob.size / 1024;
  
  if (sizeKB > 1024) { // 超過 1MB 的圖片跳過
    console.warn('[Code] 圖片過大，跳過快取:', sizeKB.toFixed(2), 'KB');
    return null;
  }
  
  return blob;
}

// 獲取圖片並轉為 base64 (繞過防盜鏈)
async function fetchImageAsBase64(imageUrl) {
  try {
    if (!imageUrl) {
      debugLog('[Code] fetchImageAsBase64: 無圖片 URL');
      return null;
    }
    
    debugLog('[Code] fetchImageAsBase64: 開始獲取圖片', imageUrl.substring(0, 60) + '...');
    
    // 在 Service Worker 中使用 mode: 'cors' 嘗試獲取
    let response;
    try {
      response = await fetchWithTimeout(imageUrl, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        headers: {
          'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          'Referer': 'https://www.javbus.com/',
          'Origin': 'https://www.javbus.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
    } catch (fetchErr) {
      debugLog('[Code] fetchImageAsBase64: CORS 獲取失敗，嘗試 no-cors 模式');
      // 如果 CORS 失敗，嘗試 no-cors 模式（但會得到 opaque response）
      try {
        response = await fetchWithTimeout(imageUrl, {
          method: 'GET',
          mode: 'no-cors',
          credentials: 'omit'
        });
        debugLog('[Code] fetchImageAsBase64: no-cors 模式請求完成');
        // no-cors 模式下無法讀取 response body，會失敗
        debugLog('[Code] fetchImageAsBase64: no-cors 模式無法讀取圖片數據');
        return null;
      } catch (noCorsErr) {
        debugLog('[Code] fetchImageAsBase64: no-cors 也失敗:', noCorsErr.message);
        return null;
      }
    }
    
    if (!response.ok) {
      debugLog('[Code] fetchImageAsBase64: 請求失敗', response.status, response.statusText);
      return null;
    }
    
    debugLog('[Code] fetchImageAsBase64: 請求成功，轉換 blob...');
    const blob = await response.blob();
    debugLog('[Code] fetchImageAsBase64: blob 大小', blob.size, 'bytes');
    
    if (blob.size === 0) {
      debugLog('[Code] fetchImageAsBase64: blob 為空');
      return null;
    }
    
    // 檢查圖片大小並決定是否處理
    const checkedBlob = await checkImageSize(blob);
    if (!checkedBlob) {
      return null;
    }
    
    const reader = new FileReader();
    
    return new Promise((resolve) => {
      reader.onloadend = () => {
        try {
          const result = reader.result;
          if (result && result.startsWith('data:')) {
            // 檢查圖片大小限制，避免過大圖片造成記憶體問題
            if (result.length > 5 * 1024 * 1024) { // 5MB 限制
              console.warn('[Code] 圖片過大，跳過快取');
              resolve(null);
              return;
            }
            debugLog('[Code] fetchImageAsBase64: FileReader 成功，長度:', result.length);
            resolve(result);
          } else {
            debugLog('[Code] fetchImageAsBase64: FileReader 結果無效');
            resolve(null);
          }
        } finally {
          // 確保 FileReader 被正確釋放
          reader.onloadend = null;
          reader.onerror = null;
        }
      };
      reader.onerror = (e) => {
        debugLog('[Code] fetchImageAsBase64: FileReader 錯誤', e);
        // 清理錯誤處理器
        reader.onloadend = null;
        reader.onerror = null;
        resolve(null);
      };
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[Code] fetchImageAsBase64 超時');
    } else {
      console.error('[Code] fetchImageAsBase64 異常:', e.message, e.stack);
    }
    return null;
  }
}

// ========== JAVDB ==========
async function fetchJavdb(id) {
  try {
    const upperId = id.toUpperCase();

    // 搜尋頁（帶超時）
    const searchRes = await fetchWithTimeout(
      `https://javdb.com/search?q=${encodeURIComponent(id)}&f=all`,
      getBrowserFetchOptions('https://javdb.com/')
    );
    if (!searchRes.ok) return null;

    const searchHtml = await searchRes.text();

    // 從搜尋結果找詳情頁連結（支援多種格式）
    // 安全處理 ID 中的特殊字符
    const safeId = upperId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const detailMatch = searchHtml.match(
      new RegExp(`href="(/v/[^"]+)"[^>]*>[^<]*<[^>]*>[^<]*${safeId.replace(/[-\s]/g, '[-\\s]')}`, 'i')
    );
    if (!detailMatch) return null;
    const detailHref = detailMatch[1];

    // 詳情頁（帶超時）
    const detailRes = await fetchWithTimeout(
      `https://javdb.com${detailHref}`,
      getBrowserFetchOptions('https://javdb.com/')
    );
    if (!detailRes.ok) return null;

    const html = await detailRes.text();

    // 解析封面（更多 pattern，包括常見的圖片位置）
    let cover = extractCover(html, [
      // 主要封面
      /class="video-cover"[^>]*src="([^"]+)"/i,
      /class="cover"[^>]*src="([^"]+)"/i,
      /class="preview"[^>]*src="([^"]+)"/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*cover/i,
      /meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<img[^>]+data-src="([^"]+\.jpg[^"]*)"/i,
      /<img[^>]+src="([^"]+thumbs[^"]+\.jpg[^"]*)"/i,
      /href="([^"]+covers[^"]+\.jpg[^"]*)"/i,
      // 擴展 pattern
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*class="[^"]*video/i,
      /<img[^>]+src="([^"]+\.jpg)"[^>]*class="[^"]*movie/i,
      /<img[^>]+src="([^"]+\.jpg)"[^>]*alt="[^"]*cover/i,
      /<img[^>]+src="([^"]+)"[^>]*title="[^"]*cover/i
    ], 'https://javdb.com');
    
    // JAVDB 圖片轉換為大圖
    if (cover) {
      // 各種小圖轉大圖的規則
      cover = cover
        .replace('/thumbs/', '/covers/')
        .replace('/small/', '/large/')
        .replace('/thumb/', '/cover/')
        .replace('thumbnail', 'cover')
        .replace('_s.', '_l.')
        .replace('_small.', '_large.');
    }

    // 解析演員：只取女優，格式「中文（日文）」
    const actors = extractJavdbActors(html);
    debugLog('[JAVDB] 找到女優:', actors);
    
    // 解析影片標題
    const title = extractTitle(html, 'javdb');
    debugLog('[JAVDB] 標題:', title);
    
    // 解析發行商（片商）
    const studio = extractStudio(html, 'javdb');
    debugLog('[JAVDB] 發行商:', studio);

    if (!title && !actors.length && !studio && !cover) return null;
    return { id: upperId, title, cover, actors, studio, source: 'javdb' };
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[JAVDB] 請求超時:', id);
    } else {
      console.error('JAVDB fetch error:', e.message);
    }
    return null;
  }
}

// 提取 JAVDB 女優，格式為「中文（日文）」
function extractJavdbActors(html) {
  const actors = [];
  // 安全限制：防止 ReDoS 攻擊
  const MAX_HTML_LENGTH = 500000;
  if (html.length > MAX_HTML_LENGTH) {
    html = html.substring(0, MAX_HTML_LENGTH);
  }
  // 尋找演員區塊（更寬鬆的匹配）
  const actorSection = html.match(/<div[^>]*class="[^"]*actor[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || 
                       html.match(/<span[^>]*class="[^"]*actor[^"]*"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
                       html.match(/演員[\s\S]*?<div[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
                       html;
  
  // 尋找所有演員連結（支持多種格式）
  const regex = /<a[^>]*href="\/actors?\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = regex.exec(actorSection)) !== null) {
    const linkHtml = m[0];
    const actorHtml = m[1];
    
    // 檢查是否為男優（排除男優標記）
    if (linkHtml.includes('♂') || linkHtml.includes('male') || 
        actorHtml.includes('♂') || linkHtml.includes('/male/') ||
        actorHtml.includes('male')) {
      continue;
    }
    
    // 解析名字 - JAVDB 格式多樣
    let zhName = '';
    let jpName = '';
    
    // 方法1: 尋找 .name 和 .alias
    const nameMatch = actorHtml.match(/class="[^"]*\bname\b[^"]*"[^>]*>([^<]+)</i);
    const aliasMatch = actorHtml.match(/class="[^"]*\balias\b[^"]*"[^>]*>([^<]+)</i);
    
    // 方法2: 尋找任意 span 內的文字
    const spanMatches = [...actorHtml.matchAll(/<span[^>]*>([^<]+)<\/span>/gi)];
    
    if (nameMatch && aliasMatch) {
      const name1 = nameMatch[1].trim();
      const name2 = aliasMatch[1].trim();
      
      // 判斷哪個是中文（含 CJK 字符）
      const isChinese1 = /[\u4e00-\u9fa5]/.test(name1);
      const isChinese2 = /[\u4e00-\u9fa5]/.test(name2);
      
      if (isChinese1 && !isChinese2) {
        zhName = name1;
        jpName = name2;
      } else if (isChinese2 && !isChinese1) {
        zhName = name2;
        jpName = name1;
      } else {
        zhName = name1;
        jpName = name2 !== name1 ? name2 : '';
      }
    } else if (spanMatches.length >= 2) {
      // 使用 span 內容
      const name1 = spanMatches[0][1].trim();
      const name2 = spanMatches[1][1].trim();
      
      const isChinese1 = /[\u4e00-\u9fa5]/.test(name1);
      const isChinese2 = /[\u4e00-\u9fa5]/.test(name2);
      
      if (isChinese1) {
        zhName = name1;
        jpName = name2 !== name1 ? name2 : '';
      } else if (isChinese2) {
        zhName = name2;
        jpName = name1;
      } else {
        zhName = name1;
        jpName = name2 !== name1 ? name2 : '';
      }
    } else if (nameMatch) {
      zhName = nameMatch[1].trim();
    } else if (spanMatches.length === 1) {
      zhName = spanMatches[0][1].trim();
    } else {
      // 備用：移除所有 HTML 標籤後取文字
      const textOnly = actorHtml.replace(/<[^>]+>/g, ' ').trim();
      const parts = textOnly.split(/\s+/).filter(p => p.length > 0);
      if (parts.length > 0) {
        zhName = parts[0];
        if (parts[1] && parts[1] !== parts[0]) jpName = parts[1];
      }
    }
    
    // 清理名字（移除多餘空格）
    zhName = zhName.replace(/\s+/g, ' ').trim();
    jpName = jpName.replace(/\s+/g, ' ').trim();
    
    if (zhName) {
      let finalName = zhName;
      if (jpName && jpName !== zhName && jpName.length > 0) {
        finalName = `${zhName}（${jpName}）`;
      }
      if (!actors.includes(finalName) && finalName.length > 0) {
        actors.push(finalName);
      }
    }
    if (actors.length >= 5) break;
  }
  
  return actors;
}

// ========== JAVBUS ==========
async function fetchJavbus(id) {
  try {
    const upperId = id.toUpperCase();
    
    const res = await fetchWithTimeout(
      `https://www.javbus.com/${encodeURIComponent(id)}`,
      getBrowserFetchOptions('https://www.javbus.com/')
    );
    if (!res.ok) return null;

    const html = await res.text();

    // 解析封面（更多 pattern，包括 JAVBUS 特有的）
    let cover = extractCover(html, [
      /<a[^>]*class="bigImage"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*cover/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*bigImage/i,
      /<img[^>]+class="[^"]*bigImage[^"]*"[^>]+src="([^"]+)"/i,
      /<a[^>]*href="[^"]*photo[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i,
      // 擴展 pattern
      /<img[^>]+src="([^"]+\.jpg)"[^>]*>/i,
      /<img[^>]+data-original="([^"]+\.jpg)"[^>]*>/i,
      /<img[^>]+src="([^"]+photos[^"]+\.jpg)"/i
    ], 'https://www.javbus.com');
    
    // JAVBUS 圖片 URL 處理
    if (cover && cover.includes('javbus')) {
      cover = cover.replace('_thumbs', '').replace('/thumbs/', '/');
    }
    
    // 解析演員：只取女優，格式「中文（日文）」
    debugLog('[JAVBUS] 開始提取女優...');
    const actors = extractJavbusActors(html);
    
    // 解析影片標題
    const title = extractTitle(html, 'javbus');
    debugLog('[JAVBUS] 標題:', title);
    
    // 解析發行商（片商）
    const studio = extractStudio(html, 'javbus');
    debugLog('[JAVBUS] 發行商:', studio);

    debugLog('[JAVBUS] 提取結果:', { id: upperId, title, cover: cover?.substring(0, 50), actors: actors.length, actorsList: actors });

    if (!cover && !actors.length && !title && !studio) {
      debugLog('[JAVBUS] 無封面/女優/標題/片商，返回 null');
      return null;
    }

    // 嘗試將圖片轉為 base64 (繞過防盜鏈)
    let coverDataUrl = null;
    if (cover) {
      debugLog('[JAVBUS] 嘗試獲取圖片 base64:', cover.substring(0, 60) + '...');
      coverDataUrl = await fetchImageAsBase64(cover);
      if (coverDataUrl) {
        debugLog('[JAVBUS] 圖片轉 base64 成功，長度:', coverDataUrl.length);
      } else {
        debugLog('[JAVBUS] 圖片轉 base64 失敗，使用原始 URL');
      }
    }

    const result = { 
      id: upperId, 
      title,
      cover: coverDataUrl || cover, // 優先使用 base64，失敗則用原始 URL
      actors, 
      studio,
      source: 'javbus' 
    };
    debugLog('[JAVBUS] 返回結果:', { ...result, cover: result.cover ? (result.cover.startsWith('data:') ? 'base64...' : result.cover.substring(0, 50)) : null });
    return result;
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[JAVBUS] 請求超時:', id);
    } else {
      console.error('[JAVBUS] fetch error:', e.message, e.stack);
    }
    return null;
  }
}

// 提取 JAVBUS 女優，格式為「中文（日文）」
function extractJavbusActors(html) {
  const actors = [];
  
  // 尋找女優區塊（多種可能的位置）
  const actressSection = html.match(/<div[^>]*id="[^"]*avatar-waterfall[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] || 
                          html.match(/<div[^>]*class="[^"]*star-box[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
                          html.match(/<div[^>]*class="[^"]*actress[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
                          html.match(/女優|出演者|Cast/i)?.[0] ? html : '';
  
  // 調試：輸出區塊長度
  debugLog('[JAVBUS] 女優區塊長度:', actressSection?.length || 0);
  
  // JAVBUS 女優格式分析
  // 常見格式1: <a href="/star/xxx"><img src="..." title="中文名 日文名"></a>
  // 常見格式2: <a href="/star/xxx"><img src="..." title="三上悠亜"></a>
  // 常見格式3: <a href="/star/xxx"><img src="..." alt="女優名"></a>
  // 常見格式4: <a href="/star/xxx">女優名</a>（直接文字）
  
  // 方法1: 從 img title/alt 提取
  const imgRegex = /<a[^>]*href="\/star\/[^"]*"[^>]*>[\s\S]*?<img[^>]+(?:title|alt)="([^"]+)"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  let matchCount = 0;
  while ((m = imgRegex.exec(actressSection)) !== null) {
    matchCount++;
    const linkHtml = m[0];
    const rawName = m[1].trim();
    
    debugLog(`[JAVBUS] 方法1 匹配 #${matchCount}:`, rawName);
    
    // 檢查是否為男優（排除）
    if (linkHtml.includes('♂') || linkHtml.includes('male') || 
        linkHtml.includes('/male/') || rawName.includes('♂')) {
      debugLog('[JAVBUS] 跳過男優:', rawName);
      continue;
    }
    
    // 解析名字
    const parsedName = parseActorName(rawName);
    debugLog('[JAVBUS] 解析後名字:', parsedName);
    if (parsedName && !actors.includes(parsedName)) {
      actors.push(parsedName);
    }
    if (actors.length >= 5) break;
  }
  
  debugLog(`[JAVBUS] 方法1: 匹配 ${matchCount} 個，有效女優 ${actors.length} 個`);
  
  // 方法2: 從 star box 連結直接提取文字
  if (actors.length === 0) {
    debugLog('[JAVBUS] 嘗試方法2: 直接從 star 連結提取');
    // 匹配 <a href="/star/123">女優名</a> 這種格式
    const starRegex = /<a[^>]*href="\/star\/[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let sm;
    let starCount = 0;
    while ((sm = starRegex.exec(html)) !== null) {
      starCount++;
      const rawName = sm[1].trim();
      debugLog(`[JAVBUS] 方法2 匹配 #${starCount}:`, rawName);
      
      if (rawName && !rawName.includes('♂') && !actors.includes(rawName) && rawName.length > 1) {
        const parsedName = parseActorName(rawName);
        if (parsedName && !actors.includes(parsedName)) {
          actors.push(parsedName);
          debugLog('[JAVBUS] 方法2 添加女優:', parsedName);
        }
      }
      if (actors.length >= 5) break;
    }
    debugLog(`[JAVBUS] 方法2: 匹配 ${starCount} 個 star 連結`);
  }
  
  // 方法3: 從特定 class 提取
  if (actors.length === 0) {
    debugLog('[JAVBUS] 嘗試方法3: 從特定 pattern 提取');
    // 嘗試各種可能的 pattern
    const patterns = [
      /<a[^>]*href="\/star\/[^"]*"[^>]*>\s*<img[^>]*>\s*([^<]+)/gi,
      /<div[^>]*star[^>]*>\s*<a[^>]*>([^<]+)/gi,
      /<span[^>]*star[^>]*>\s*<a[^>]*>([^<]+)/gi
    ];
    
    for (const pattern of patterns) {
      let pm;
      while ((pm = pattern.exec(html)) !== null) {
        const rawName = pm[1]?.trim();
        debugLog('[JAVBUS] 方法3 匹配:', rawName);
        if (rawName && !rawName.includes('♂') && !actors.includes(rawName) && rawName.length > 1) {
          const parsedName = parseActorName(rawName);
          if (parsedName && !actors.includes(parsedName)) {
            actors.push(parsedName);
          }
        }
        if (actors.length >= 5) break;
      }
      if (actors.length >= 5) break;
    }
  }
  
  return actors;
}

// ========== JAVLibrary (備選數據源) ==========
async function fetchJavlibrary(id) {
  try {
    const upperId = id.toUpperCase();
    
    // JAVLibrary 查詢 URL
    const res = await fetchWithTimeout(
      `https://www.javlibrary.com/tw/vl_searchbyid.php?keyword=${encodeURIComponent(id)}`,
      getBrowserFetchOptions('https://www.javlibrary.com/tw/')
    );
    
    if (!res.ok) return null;

    const html = await res.text();

    // 尋找第一個搜尋結果
    const resultMatch = html.match(/<a href="\.\/(\?v=jav[^"]+)"[^>]*>[^<]*<[^>]*>([^<]+)/i);
    if (!resultMatch) return null;
    
    const detailHref = resultMatch[1];
    const foundId = resultMatch[2].trim().toUpperCase();
    
    // 檢查番號是否匹配（允許一些變體）
    const baseId = upperId.replace(/[-_\s]/g, '');
    const foundBaseId = foundId.replace(/[-_\s]/g, '');
    
    if (baseId !== foundBaseId) {
      debugLog('[JAVLibrary] 番號不匹配:', baseId, '!==', foundBaseId);
      return null;
    }

    // 獲取詳情頁
    const detailRes = await fetchWithTimeout(
      `https://www.javlibrary.com/tw/${detailHref}`,
      getBrowserFetchOptions('https://www.javlibrary.com/tw/')
    );
    
    if (!detailRes.ok) return null;
    
    const detailHtml = await detailRes.text();

    // 解析封面
    let cover = extractCover(detailHtml, [
      /<img[^>]+src="([^"]+video\.jpg[^"]*)"/i,
      /<img[^>]+src="([^"]+)"[^>]*id="video_jacket_img/i,
      /<img[^>]+src="([^"]+jacket[^"]*)"/i,
      /<img[^>]+src="([^"]+\/covers\/[^"]*)"/i,
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*id="video_jacket/i
    ], 'https://www.javlibrary.com');
    
    // JAVLibrary 圖片通常是絕對路徑，需要補充域名
    if (cover && cover.startsWith('/')) {
      cover = 'https://www.javlibrary.com' + cover;
    }

    // 解析標題、片商、女優 - JAVLibrary 格式
    const title = extractTitle(detailHtml, 'javlibrary');
    const studio = extractStudio(detailHtml, 'javlibrary');
    const actors = extractJavlibraryActors(detailHtml);
    
    debugLog('[JAVLibrary] 提取結果:', { id: upperId, title, studio, cover: cover?.substring(0, 50), actors: actors.length });

    if (!cover && !actors.length && !title && !studio) return null;

    return { 
      id: upperId, 
      title,
      cover, 
      actors, 
      studio,
      source: 'javlibrary' 
    };
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[JAVLibrary] 請求超時:', id);
    } else {
      console.error('[JAVLibrary] fetch error:', e.message);
    }
    return null;
  }
}

function getBrowserFetchOptions(referer) {
  return {
    // 安全性：不攜帶使用者在第三方站台的登入 Cookie，避免任意頁面
    // 藉由埋入番號字串來強迫瀏覽器發出「帶登入態」的跨站請求（去匿名化風險）。
    // 番號基本資訊可匿名查詢，故不需要 credentials。
    credentials: 'omit',
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8,ja;q=0.7',
      'Cache-Control': 'max-age=0',
      'Referer': referer || '',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };
}

// ========== 輕量存在檢查（只用於 CHECK_EXISTS）==========
async function fetchJavdbExists(id) {
  try {
    const upperId = id.toUpperCase();
    const res = await fetchWithTimeout(
      `https://javdb.com/search?q=${encodeURIComponent(upperId)}&f=all`,
      getBrowserFetchOptions('https://javdb.com/')
    );
    if (res.ok) {
      debugLog('[JAVDB_EXISTS] HTTP status:', id, res.status, res.ok);
    } else {
      debugLog('[JAVDB_EXISTS] HTTP status:', id, res.status, res.ok);
      return null;
    }
    const html = await res.text();
    debugLog('[JAVDB_EXISTS] HTML length:', id, html.length, 'startsWith:', html.substring(0, 80).replace(/\s+/g, ' '));

    // 無結果頁通常出現 "No result" 或 "找不到"
    const noResult = /No result|找不到|no results/i.test(html);

    // 搜尋結果列表常見 class
    const hasResult = /<div[^>]*class="[^"]*(?:box|item|grid-item|movie-item|video-item)[^"]*"[^>]*>/i.test(html) ||
                      /<a[^>]*href="\/v\/[^"]+"[^>]*>/i.test(html);
    debugLog('[JAVDB_EXISTS] check:', id, 'noResult:', noResult, 'hasResult:', hasResult);
    if (noResult || !hasResult) return null;

    // 嘗試撈片名
    const titleMatch = html.match(/class="video-title"[^>]*>([^<]+)</i) ||
                       html.match(/class="title"[^>]*>([^<]+)</i);
    return { id: upperId, title: titleMatch?.[1]?.trim() || upperId, source: 'javdb-exists' };
  } catch (e) {
    debugLog('[JAVDB_EXISTS] 輕量檢查失敗:', id, e.message);
    return null;
  }
}

async function fetchJavbusExists(id) {
  try {
    const upperId = id.toUpperCase();
    const res = await fetchWithTimeout(
      `https://www.javbus.com/${encodeURIComponent(upperId)}`,
      getBrowserFetchOptions('https://www.javbus.com/')
    );
    if (res.ok) {
      debugLog('[JAVBUS_EXISTS] HTTP status:', id, res.status, res.ok);
    } else {
      debugLog('[JAVBUS_EXISTS] HTTP status:', id, res.status, res.ok);
      return null;
    }

    const html = await res.text();
    debugLog('[JAVBUS_EXISTS] HTML length:', id, html.length, 'startsWith:', html.substring(0, 80).replace(/\s+/g, ' '));

    // 確認頁面真的有影片資料（放寬條件）
    const hasMovie = /<a[^>]*class="bigImage"[^>]*>/i.test(html) ||
                     /<h3[^>]*>/i.test(html) ||
                     /class="info"/i.test(html) ||
                     /<div[^>]*class="container"[^>]*>/i.test(html) ||
                     html.includes(upperId);
    debugLog('[JAVBUS_EXISTS] check:', id, 'hasMovie:', hasMovie, 'containsId:', html.includes(upperId));
    if (!hasMovie) return null;

    const titleMatch = html.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    return { id: upperId, title: titleMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || upperId, source: 'javbus-exists' };
  } catch (e) {
    debugLog('[JAVBUS_EXISTS] 輕量檢查失敗:', id, e.message);
    return null;
  }
}

async function fetchJavlibraryExists(id) {
  try {
    const upperId = id.toUpperCase();
    const res = await fetchWithTimeout(
      `https://www.javlibrary.com/tw/vl_searchbyid.php?keyword=${encodeURIComponent(upperId)}`,
      getBrowserFetchOptions('https://www.javlibrary.com/tw/')
    );
    if (res.ok) {
      debugLog('[JAVLIBRARY_EXISTS] HTTP status:', id, res.status, res.ok);
    } else {
      debugLog('[JAVLIBRARY_EXISTS] HTTP status:', id, res.status, res.ok);
      return null;
    }

    const html = await res.text();
    debugLog('[JAVLIBRARY_EXISTS] HTML length:', id, html.length, 'startsWith:', html.substring(0, 80).replace(/\s+/g, ' '));

    // 無結果頁會出現 "No result" 或 "搜尋沒有結果"
    const noResult = /No result|搜尋沒有結果|no result/i.test(html);

    // 有結果時會出現 ./?v=javxxx
    const resultMatch = html.match(/<a href="\.\/(\?v=jav[^"]+)"[^>]*>[^<]*<[^>]*>([^<]+)</i);
    debugLog('[JAVLIBRARY_EXISTS] check:', id, 'noResult:', noResult, 'resultMatch:', !!resultMatch);
    if (noResult || !resultMatch) return null;

    const foundId = resultMatch[2].trim().toUpperCase();
    const baseId = upperId.replace(/[-_\s]/g, '');
    const foundBaseId = foundId.replace(/[-_\s]/g, '');
    if (baseId !== foundBaseId) return null;

    return { id: upperId, title: foundId, source: 'javlibrary-exists' };
  } catch (e) {
    debugLog('[JAVLIBRARY_EXISTS] 輕量檢查失敗:', id, e.message);
    return null;
  }
}

// 提取 JAVLibrary 女優
function extractJavlibraryActors(html) {
  const actors = [];
  
  // 尋找女優區塊（使用更簡單的 pattern）
  const actressSection = html.match(/<span[^>]*class="cast"[^>]*>[\s\S]*?<span[^>]*class="star"[^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
                          html.match(/<td[^>]*class="cast"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ||
                          '';
  
  if (actressSection) {
    // 尋找所有女優連結
    const actressRegex = /<a href="[^"]*star=[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = actressRegex.exec(actressSection)) !== null) {
      const name = m[1].trim();
      if (name && !name.includes('♂') && !actors.includes(name)) {
        actors.push(name);
      }
      if (actors.length >= 5) break;
    }
  }
  
  // 備用方法：從 cast list 提取
  if (actors.length === 0) {
    const castRegex = /<a href="[^"]*\/star\.php\?s=[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = castRegex.exec(html)) !== null) {
      const name = m[1].trim();
      if (name && !name.includes('♂') && !actors.includes(name)) {
        actors.push(name);
      }
      if (actors.length >= 5) break;
    }
  }
  
  debugLog('[JAVLibrary] 找到女優:', actors);
  return actors;
}

// 提取影片標題
function extractTitle(html, source) {
  let title = null;
  
  if (source === 'javdb') {
    // JAVDB 格式
    const patterns = [
      /<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)<\/h1>/i,
      /<title>([^|]+)/i,
      /<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i,
      /<span[^>]*class="[^"]*video-title[^"]*"[^>]*>([^<]+)<\/span>/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        title = match[1].trim();
        // 清理標題中的多餘文字
        title = title.replace(/-\s*JAVDB.*$/i, '').replace(/\s*-\s*影片$/i, '');
        if (title) break;
      }
    }
  } else if (source === 'javbus') {
    // JAVBUS 格式
    const patterns = [
      /<h1[^>]*>([^<]+)<\/h1>/i,
      /<title>([^-]+)/i,
      /<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        title = match[1].trim();
        title = title.replace(/\s*-\s*JAVBUS.*$/i, '');
        if (title) break;
      }
    }
  } else if (source === 'javlibrary') {
    // JAVLibrary 格式
    const patterns = [
      /<td[^>]*class="label"[^>]*>タイトル<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/i,
      /<h3[^>]*class="[^"]*post-title[^"]*"[^>]*>([^<]+)<\/h3>/i,
      /<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        title = match[1].replace(/<[^>]+>/g, '').trim(); // 移除 HTML 標籤
        if (title) break;
      }
    }
  }
  
  return title;
}

// 提取發行商（片商）信息
function extractStudio(html, source) {
  let studio = null;
  
  if (source === 'javdb') {
    // JAVDB 格式：尋找片商信息
    const patterns = [
      /<a[^>]*href="[^"]*\/studio\/[^"]*"[^>]*>([^<]+)<\/a>/i,
      /<span[^>]*class="[^"]*studio[^"]*"[^>]*>([^<]+)<\/span>/i,
      /<td[^>]*>片商<\/td>\s*<td[^>]*>([^<]+)<\/td>/i,
      /<td[^>]*>發行商<\/td>\s*<td[^>]*>([^<]+)<\/td>/i,
      /<div[^>]*class="[^"]*studio[^"]*"[^>]*>([^<]+)<\/div>/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        studio = match[1].trim();
        break;
      }
    }
  } else if (source === 'javbus') {
    // JAVBUS 格式
    const patterns = [
      /<a[^>]*href="[^"]*\/studio\/[^"]*"[^>]*>([^<]+)<\/a>/i,
      /<span[^>]*class="[^"]*studio[^"]*"[^>]*>([^<]+)<\/span>/i,
      /<td[^>]*>片商<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        studio = match[1].trim();
        break;
      }
    }
  } else if (source === 'javlibrary') {
    // JAVLibrary 格式
    const patterns = [
      /<a[^>]*href="[^"]*\/vl_searchbyid\.php[^"]*studio[^"]*"[^>]*>([^<]+)<\/a>/i,
      /<td[^>]*class="label"[^>]*>メーカー<\/td>\s*<td[^>]*>([^<]+)<\/td>/i,
      /<td[^>]*class="label"[^>]*>レーベル<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
    ];
    
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) {
        studio = match[1].trim();
        break;
      }
    }
  }
  
  return studio;
}

// 解析演員名字，優先返回日文名字
function parseActorName(rawName) {
  if (!rawName) return null;
  
  rawName = rawName.trim().replace(/\s+/g, ' ');
  
  // 如果已經是「中文（日文）」格式，提取日文部分
  const bracketMatch = rawName.match(/(.+?)（(.+?)）/);
  if (bracketMatch) {
    return bracketMatch[2]; // 返回日文名
  }
  
  // 檢查是否包含空格分隔的名字
  // 例如: "三上悠亜 Mikami Yua" 或 "中文 日文"
  const parts = rawName.split(/\s+/);
  if (parts.length >= 2) {
    let japaneseParts = [];
    
    for (const part of parts) {
      // 日文假名或英文視為日文名
      if (/[\u3040-\u309f\u30a0-\u30ffa-zA-Z]/.test(part)) {
        japaneseParts.push(part);
      }
    }
    
    // 如果有日文部分，優先使用
    if (japaneseParts.length > 0) {
      return japaneseParts.join(' ');
    }
  }
  
  // 單一名字：檢查是否包含日文假名
  const hasKana = /[\u3040-\u309f\u30a0-\u30ff]/.test(rawName);
  if (hasKana) {
    return rawName;
  }
  
  // 清理並返回（移除男優符號等）
  return rawName.replace(/[♂]/g, '').trim();
}

// ========== JAVLibrary 僅獲取封面（用於補充其他數據源）==========
async function fetchJavlibraryCoverOnly(id) {
  try {
    const upperId = id.toUpperCase();
    debugLog('[JAVLibrary] 僅獲取封面:', upperId);
    
    // 搜索頁面
    const res = await fetchWithTimeout(
      `https://www.javlibrary.com/tw/vl_searchbyid.php?keyword=${encodeURIComponent(id)}`,
      { 
        headers: { 
          'Accept': 'text/html',
          'Accept-Language': 'zh-TW'
        }
      }
    );
    
    if (!res.ok) return null;

    const html = await res.text();

    // 尋找第一個搜尋結果
    const resultMatch = html.match(/<a href="\.\/(\?v=jav[^"]+)"[^>]*>[^<]*<[^>]*>([^<]+)/i);
    if (!resultMatch) return null;
    
    const detailHref = resultMatch[1];
    const foundId = resultMatch[2].trim().toUpperCase();
    
    // 檢查番號是否匹配
    const baseId = upperId.replace(/[-_\s]/g, '');
    const foundBaseId = foundId.replace(/[-_\s]/g, '');
    
    if (baseId !== foundBaseId) {
      debugLog('[JAVLibrary] 番號不匹配:', baseId, '!==', foundBaseId);
      return null;
    }

    // 獲取詳情頁
    const detailRes = await fetchWithTimeout(
      `https://www.javlibrary.com/tw/${detailHref}`,
      getBrowserFetchOptions('https://www.javlibrary.com/tw/')
    );
    
    if (!detailRes.ok) return null;
    
    const detailHtml = await detailRes.text();

    // 解析封面
    let cover = extractCover(detailHtml, [
      /<img[^>]+src="([^"]+video\.jpg[^"]*)"/i,
      /<img[^>]+src="([^"]+)"[^>]*id="video_jacket_img/i,
      /<img[^>]+src="([^"]+jacket[^"]*)"/i,
      /<img[^>]+src="([^"]+\/covers\/[^"]*)"/i,
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*id="video_jacket/i
    ], 'https://www.javlibrary.com');
    
    if (cover && cover.startsWith('/')) {
      cover = 'https://www.javlibrary.com' + cover;
    }
    
    debugLog('[JAVLibrary] 僅獲取封面結果:', cover ? '成功' : '失敗', cover?.substring(0, 50));
    return cover;
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[JAVLibrary] 僅獲取封面超時:', id);
    } else {
      console.error('[JAVLibrary] 僅獲取封面錯誤:', e.message);
    }
    return null;
  }
}

// ========== 圖片預加載到本地快取 ==========
async function preloadImageToCache(cacheKey, imageUrl) {
  try {
    // 檢查是否已有快取
    const cached = await cache.getImage(cacheKey);
    if (cached) {
      debugLog('[Cache] 圖片已快取，跳過:', cacheKey);
      return;
    }
    
    debugLog('[Cache] 開始下載圖片:', imageUrl.substring(0, 50) + '...');
    
    // 嘗試下載圖片
    const response = await fetchWithTimeout(imageUrl, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      headers: {
        'Accept': 'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Referer': 'https://www.javlibrary.com/',
        'Origin': 'https://www.javlibrary.com'
      }
    });
    
    if (!response.ok) {
      debugLog('[Cache] 圖片下載失敗:', response.status);
      return;
    }
    
    // 轉換為 base64
    const blob = await response.blob();
    if (blob.size === 0) {
      debugLog('[Cache] 圖片 blob 為空');
      return;
    }
    
    const reader = new FileReader();
    const base64Data = await new Promise((resolve, reject) => {
      reader.onloadend = () => {
        const result = reader.result;
        if (result && result.startsWith('data:')) {
          resolve(result);
        } else {
          reject(new Error('FileReader 結果無效'));
        }
      };
      reader.onerror = () => reject(new Error('FileReader 錯誤'));
      reader.readAsDataURL(blob);
    });
    
    // 存入快取
    await cache.setImage(cacheKey, base64Data);
    debugLog('[Cache] 圖片快取成功，大小:', Math.round(base64Data.length / 1024), 'KB');
    
  } catch (e) {
    console.warn('[Cache] 圖片預加載失敗:', e.message);
    throw e;
  }
}

// ========== 請求去重（避免並發相同請求）==========
/**
 * pendingRequests: 請求去重機制
 *
 * 問題場景：用戶快速懸停多個相同番號，或頁面有多個相同番號標記
 * 解決方案：使用 Map 存儲進行中的請求 Promise，相同番號直接返回共享 Promise
 *
 * 流程：
 * 1. 收到請求時檢查 pendingRequests 是否有相同 key
 * 2. 有則直接返回該 Promise（共享結果）
 * 3. 無則創建新 Promise，存入 Map，完成後從 Map 刪除
 *
 * 注意：必須在 finally 中刪除，確保即使請求失敗也不會永久佔用
 */
const pendingRequests = new Map();

/**
 * 等待多個 Promise，回傳第一個非 null 結果；
 * 若全部 settle 仍無結果，或超時，回傳 null。
 */
function raceFirstNonNull(promises, timeoutMs) {
  return new Promise((resolve) => {
    let pending = promises.length;
    let settled = false;
    if (pending === 0) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);
    promises.forEach(p => {
      Promise.resolve(p).then(result => {
        if (!settled && result !== null && result !== undefined) {
          settled = true;
          clearTimeout(timer);
          resolve(result);
        }
      }).catch(() => {
        // 忽略個別失敗
      }).finally(() => {
        pending--;
        if (pending === 0 && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  });
}

// ========== 輕量存在檢查（只用於 CHECK_EXISTS）==========
async function fetchCodeExists(id) {
  const normalizedId = id.toUpperCase().trim();
  const cacheKey = `code_${normalizedId}`;

  // 1. 先查快取
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  // 2. 多源並行快速查詢（JAVDB + JAVBUS），等待第一個非 null 結果
  // 使用輕量存在檢查（不進 detail 頁），避免 JAVDB 登入牆
  try {
    const result = await raceFirstNonNull([
      fetchJavdbExists(normalizedId),
      fetchJavbusExists(normalizedId)
    ], 8000);
    if (result) {
      debugLog('[Code] JAVDB/JAVBUS 快速存在檢查成功:', id, result.source);
      await cache.set(cacheKey, result);
      return result;
    }
    debugLog('[Code] JAVDB/JAVBUS 快速存在檢查無結果:', id);
  } catch (e) {
    debugLog('[Code] 快速存在檢查異常:', id, e.message);
  }

  // 3. 備援：JAVLibrary（JAVDB/JAVBUS 都失敗或回傳 null 時）
  try {
    debugLog('[Code] 嘗試 JAVLibrary 備援:', id);
    const fallback = await raceFirstNonNull([
      fetchJavlibraryExists(normalizedId)
    ], 8000);
    if (fallback) {
      debugLog('[Code] JAVLibrary 備援成功:', id, fallback.source);
      await cache.set(cacheKey, fallback);
      return fallback;
    }
  } catch (e) {
    debugLog('[Code] JAVLibrary 備援失敗:', id, e.message);
  }

  return null;
}

// ========== 主查詢 ==========
/**
 * fetchCodeInfo: 核心數據查詢函數
 *
 * 查詢流程：
 * 1. 快取檢查（命中則直接返回）
 * 2. 請求去重檢查（避免並發重複請求）
 * 3. 多數據源查詢（按優先級順序）
 * 4. 數據合併（取各源最佳欄位）
 * 5. 存入快取並返回
 *
 * 數據源優先級（準確性與穩定性考量）：
 * 1. JAVLibrary (日本官方) - 數據最準確，優先使用其女優和封面
 * 2. JAVDB (中文站) - 有中文片名時補充 title，女優數據備份
 * 3. JAVBUS (中文站) - 主要備份數據源
 * 4. MGStage (日本官方) - 特定片商補充
 *
 * 數據合併策略：
 * - 優先使用 JAVLibrary 的 cover（官方圖片質量最高）
 * - 優先使用 JAVLibrary 的 actors（日文原名最準確）
 * - 補充 JAVDB/JAVBUS 的 title（中文片名）
 * - 合併時標記數據源來源（source 欄位）
 *
 * @param {string} id - 番號（如 "ABC-123"）
 * @returns {Promise<Object|null>} - 影片資訊或 null（查詢失敗）
 */
async function fetchCodeInfo(id) {
  // 標準化：大寫 + 去除首尾空格（確保快取 key 一致性）
  const normalizedId = id.toUpperCase().trim();
  const cacheKey = `code_${normalizedId}`;

  // ========== 步驟 1：快取檢查 ==========
  const cached = await cache.get(cacheKey);
  if (cached) {
    // 只有輕量存在資料（無女優/片商）時，視為不完整，重新抓取
    const hasDetails = cached.actors?.length > 0 || cached.studio;
    if (hasDetails) return cached;
    debugLog('[Code] 快取僅含輕量資料，重新抓取完整資訊:', normalizedId);
  }

  // ========== 步驟 2：請求去重檢查 ==========
  if (pendingRequests.has(cacheKey)) {
    return pendingRequests.get(cacheKey);
  }

  // ========== 步驟 3：建立新查詢 Promise ==========
  const requestPromise = (async () => {
    try {
      // 多數據源策略：日本官方優先，逐層補充
      let result = await fetchJavlibrary(normalizedId);
      
      if (!result || !result.cover || result.actors.length === 0) {
        debugLog('[Code] JAVLibrary 不完整，嘗試 JAVDB:', normalizedId);
        const javdbResult = await fetchJavdb(normalizedId);
        // 合併數據：保留 JAVLibrary 的圖片，補充 JAVDB 的女優
        if (javdbResult) {
          if (!result) {
            result = javdbResult;
          } else {
            // 合併：JAVLibrary 圖片 + JAVDB 女優/標題/片商
            if (!result.cover && javdbResult.cover) {
              result.cover = javdbResult.cover;
            }
            if (result.actors.length === 0 && javdbResult.actors.length > 0) {
              result.actors = javdbResult.actors;
            }
            if (!result.title && javdbResult.title) {
              result.title = javdbResult.title;
            }
            if (!result.studio && javdbResult.studio) {
              result.studio = javdbResult.studio;
            }
            result.source = 'javlibrary+javdb';
          }
        }
      }
      
      if (!result) {
        debugLog('[Code] 嘗試 JAVBUS:', normalizedId);
        result = await fetchJavbus(normalizedId);
        
        // JAVBUS 成功但沒有封面時，嘗試用 JAVLibrary 補充封面
        if (result && !result.cover) {
          debugLog('[Code] JAVBUS 無封面，嘗試 JAVLibrary 補充:', normalizedId);
          const javlibCover = await fetchJavlibraryCoverOnly(normalizedId);
          if (javlibCover) {
            result.cover = javlibCover;
            result.source = 'javbus+javlibrary-cover';
            debugLog('[Code] JAVLibrary 封面補充成功');
          }
        }
      }
      
      if (!result) {
        debugLog('[Code] 嘗試 MGStage (日本):', normalizedId);
        result = await fetchMgstage(normalizedId);
      }

      if (!result) {
        debugLog('[Code] 嘗試 3xplanet 備援:', normalizedId);
        result = await fetchThreexplanet(normalizedId);
      } else if (!result.title || result.actors.length === 0) {
        debugLog('[Code] 嘗試 3xplanet 補充缺失欄位:', normalizedId);
        const txpResult = await fetchThreexplanet(normalizedId);
        if (txpResult) {
          if (!result.title && txpResult.title) result.title = txpResult.title;
          if (result.actors.length === 0 && txpResult.actors.length > 0) result.actors = txpResult.actors;
          if (!result.studio && txpResult.studio) result.studio = txpResult.studio;
          if (!result.cover && txpResult.cover) result.cover = txpResult.cover;
          result.source = result.source + '+3xplanet';
        }
      }

      if (!result) {
        debugLog('[Code] 嘗試 JavDatabase 備援:', normalizedId);
        result = await fetchJavdatabase(normalizedId);
      } else if (!result.title || result.actors.length === 0) {
        debugLog('[Code] 嘗試 JavDatabase 補充缺失欄位:', normalizedId);
        const jdbResult = await fetchJavdatabase(normalizedId);
        if (jdbResult) {
          if (!result.title && jdbResult.title) result.title = jdbResult.title;
          if (result.actors.length === 0 && jdbResult.actors.length > 0) result.actors = jdbResult.actors;
          if (!result.studio && jdbResult.studio) result.studio = jdbResult.studio;
          if (!result.cover && jdbResult.cover) result.cover = jdbResult.cover;
          result.source = result.source + '+javdatabase';
        }
      }

      if (!result) {
        debugLog('[Code] 嘗試 JavMost 備援:', normalizedId);
        result = await fetchJavmost(normalizedId);
      } else if (!result.title || result.actors.length === 0) {
        // 已有結果但缺少片名或女優，嘗試用 JavMost 補充
        debugLog('[Code] 嘗試 JavMost 補充缺失欄位:', normalizedId);
        const javmostResult = await fetchJavmost(normalizedId);
        if (javmostResult) {
          if (!result.title && javmostResult.title) result.title = javmostResult.title;
          if (result.actors.length === 0 && javmostResult.actors.length > 0) result.actors = javmostResult.actors;
          if (!result.studio && javmostResult.studio) result.studio = javmostResult.studio;
          if (!result.cover && javmostResult.cover) result.cover = javmostResult.cover;
          result.source = result.source + '+javmost';
        }
      }

      if (result) {
        debugLog('[Code] 最終數據源:', result.source, '封面:', result.cover ? '有' : '無', '女優:', result.actors.length);
        
        // 封面圖片功能已移除，專注於文字資訊
        await cache.set(cacheKey, result);
      } else {
        debugLog('[Code] 所有數據源均無結果:', normalizedId);
      }
      
      // 網路全失敗時，回傳快取中的輕量資料也好過 null
      return result || cached || null;
    } finally {
      pendingRequests.delete(cacheKey);
    }
  })();

  pendingRequests.set(cacheKey, requestPromise);
  return requestPromise;
}

// ========== 訊息處理 ==========
/**
 * chrome.runtime.onMessage API 說明：
 *
 * 支援的訊息類型：
 * 1. FETCH_CODE - 查詢番號資訊
 *    - 請求：{ type: 'FETCH_CODE', id: 'ABC-123' }
 *    - 回應：{ success: true, data: {...} } 或 { success: false, error: '...' }
 *
 * 2. CLEAR_CACHE - 清除所有快取
 *    - 請求：{ type: 'CLEAR_CACHE' }
 *    - 回應：{ success: true, removed: 123 }
 *
 * 安全機制：
 * - Sender 驗證：只接受來自 content script（有 tab.id）或擴展內部頁面的訊息
 * - 輸入驗證：番號格式正則檢查，防止無效請求
 * - 異步回應：返回 true 表示使用 sendResponse 異步回應
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // ========== 安全驗證：檢查訊息來源 ==========
  // 只接受：1) 有 tab.id 的 content script 或 2) 擴展內部頁面
  if (!sender?.tab?.id && !sender?.url?.startsWith('chrome-extension://')) {
    sendResponse({ success: false, error: 'Invalid sender' });
    return false;  // 不支援異步回應
  }

  // ========== API: FETCH_CODE - 查詢番號資訊 ==========
  if (msg.type === 'FETCH_CODE') {
    // 輸入驗證：防禦性檢查，防止無效/惡意請求
    const id = msg.id;
    if (!id || typeof id !== 'string' || !/^[A-Z0-9][-A-Z0-9]{2,12}$/i.test(id)) {
      sendResponse({ success: false, error: 'Invalid ID format' });
      return false;
    }

    // 異步查詢並回應
    fetchCodeInfo(id)
      .then(data => sendResponse({ success: !!data, data }))
      .catch(err => {
        console.error('Fetch error:', err);
        sendResponse({ success: false, error: 'Request failed' });
      });
    return true;  // 表示使用異步 sendResponse
  }

  // ========== API: CHECK_EXISTS - 檢查番號是否存在于資料庫 ==========
  if (msg.type === 'CHECK_EXISTS') {
    const id = msg.id;
    if (!id || typeof id !== 'string' || !/^[A-Z0-9][-A-Z0-9]{2,12}$/i.test(id)) {
      sendResponse({ success: false, error: 'Invalid ID format' });
      return false;
    }
    
    const upperId = id.toUpperCase();
    const cacheKey = `code_${upperId}`;
    
    // 先檢查快取
    cache.get(cacheKey).then(cached => {
      if (cached) {
        // 快取中有資料，表示番號存在
        sendResponse({ success: true, cached: true, data: cached });
        return;
      }
      
      // 快取中沒有，使用輕量查詢（JAVDB/JAVBUS + JAVLibrary 備援）
      fetchCodeExists(upperId).then(data => {
        if (data) {
          sendResponse({ success: true, cached: false, data });
        } else {
          sendResponse({ success: false, error: 'Not found' });
        }
      }).catch(err => {
        console.error('[CHECK_EXISTS] Query error:', err);
        sendResponse({ success: false, error: 'Query failed' });
      });
    }).catch(err => {
      console.error('[CHECK_EXISTS] Cache error:', err);
      // 快取失敗，直接查詢資料庫
      fetchCodeExists(upperId).then(data => {
        if (data) {
          sendResponse({ success: true, data });
        } else {
          sendResponse({ success: false, error: 'Not found' });
        }
      }).catch(() => {
        sendResponse({ success: false, error: 'Query failed' });
      });
    });
    
    return true; // 異步回應
  }

  // ========== API: CLEAR_CACHE - 清除所有快取 ==========
  if (msg.type === 'CLEAR_CACHE') {
    chrome.storage.local.get(null, items => {
      const keys = Object.keys(items).filter(k => k.startsWith('code_'));
      if (!keys.length) {
        sendResponse({ success: true, removed: 0 });
        return;
      }
      chrome.storage.local.remove(keys, () => {
        const err = chrome.runtime.lastError;
        sendResponse({ 
          success: !err, 
          removed: err ? 0 : keys.length,
          error: err?.message 
        });
      });
    });
    return true;
  }

  return false;
});

// ========== 3xplanet 數據源 ==========
async function fetchThreexplanet(id) {
  try {
    const upperId = id.toUpperCase();
    debugLog('[3xplanet] 請求:', upperId);

    const res = await fetchWithTimeout(
      `https://3xplanet.com/${encodeURIComponent(upperId)}/`,
      getBrowserFetchOptions('https://3xplanet.com/')
    );
    if (!res.ok) return null;

    const html = await res.text();
    debugLog('[3xplanet] HTML 長度:', html.length);

    // 確認頁面有此番號
    if (!html.includes(upperId) && !html.toLowerCase().includes(upperId.toLowerCase())) {
      debugLog('[3xplanet] 頁面不含番號，跳過');
      return null;
    }

    // 提取封面
    const cover = extractCover(html, [
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*wp-post-image/i,
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*class="[^"]*attachment/i
    ]);

    // 提取日文片名（h1 或 og:title，去掉女優名尾巴）
    let title = null;
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i);
    const h1Match = html.match(/<h1[^>]*class="[^"]*entry-title[^"]*"[^>]*>([^<]+)<\/h1>/i) ||
                    html.match(/<h1[^>]*>([^<]{10,})<\/h1>/i);
    const raw = ogTitle?.[1] || h1Match?.[1];
    if (raw) {
      title = raw
        .replace(/\s*[-|]\s*3xplanet.*$/i, '')
        .replace(/\s*[-|]\s*Japanese Adult.*$/i, '')
        .trim();
    }

    // 提取日文女優（出演者: 欄位）
    const actors = [];
    const actorMatch = html.match(/出演者[：:]\s*([^\n<]+)/);
    if (actorMatch?.[1]) {
      actorMatch[1].split(/[\s　]+/).forEach(name => {
        name = name.trim();
        if (name && name.length > 1 && !actors.includes(name)) actors.push(name);
      });
    }
    // 備用：從 Starring: 欄位取英文名
    if (actors.length === 0) {
      const starringMatch = html.match(/Starring:\s*([^\n<]+)/i);
      if (starringMatch?.[1]) {
        starringMatch[1].split(/,\s*/).forEach(name => {
          name = name.trim();
          if (name && name.length > 1 && !actors.includes(name)) actors.push(name);
        });
      }
    }

    // 提取日文片商（メーカー: 欄位）
    let studio = null;
    const makerMatch = html.match(/メーカー[：:]\s*([^\n<]+)/) ||
                       html.match(/Studio:\s*([^\n<,\[]+)/i);
    if (makerMatch?.[1]) {
      studio = makerMatch[1].trim();
    }

    debugLog('[3xplanet] 提取結果:', { id: upperId, title, cover: cover?.substring(0, 50), actors, studio });

    if (!title && !actors.length && !studio) return null;

    return { id: upperId, title, cover, actors, studio, source: '3xplanet' };
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[3xplanet] 請求超時:', id);
    } else {
      console.error('[3xplanet] fetch error:', e.message);
    }
    return null;
  }
}

// ========== JAV Database 數據源 ==========
async function fetchJavdatabase(id) {
  try {
    const upperId = id.toUpperCase();
    const lowerId = id.toLowerCase();
    debugLog('[JavDatabase] 請求:', upperId);

    const res = await fetchWithTimeout(
      `https://www.javdatabase.com/movies/${encodeURIComponent(lowerId)}/`,
      getBrowserFetchOptions('https://www.javdatabase.com/')
    );
    if (!res.ok) return null;

    const html = await res.text();
    debugLog('[JavDatabase] HTML 長度:', html.length);

    // 確認頁面有此番號
    if (!html.includes(upperId) && !html.includes(lowerId)) {
      debugLog('[JavDatabase] 頁面不含番號，跳過');
      return null;
    }

    // 提取封面
    const cover = extractCover(html, [
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*cover/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*poster/i,
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*alt="[^"]*cover/i
    ]);

    // 提取片名（Title: 欄位）
    let title = null;
    const titleFieldMatch = html.match(/Title:\s*<\/[^>]+>\s*([^<\n]{5,})/i) ||
                            html.match(/Title:\s*([^\n<]{5,})/i);
    if (titleFieldMatch?.[1]) {
      title = titleFieldMatch[1].trim();
    } else {
      // 備用：og:title 或 h1，去掉番號前綴
      const ogMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
                      html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (ogMatch?.[1]) {
        title = ogMatch[1]
          .replace(new RegExp('^' + upperId + '\\s*[-–]?\\s*', 'i'), '')
          .replace(/\s*[-|]\s*JAV Database.*$/i, '')
          .trim();
      }
    }

    // 提取女優（從 /idols/ 連結）
    const actors = [];
    const idolRegex = /<a[^>]*href="[^"]*\/idols\/[^"]*"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = idolRegex.exec(html)) !== null) {
      const name = m[1].trim();
      if (name && !actors.includes(name) && name.length > 1) {
        actors.push(name);
      }
      if (actors.length >= 5) break;
    }

    // 提取片商（從 /studios/ 連結）
    let studio = null;
    const studioMatch = html.match(/<a[^>]*href="[^"]*\/studios\/[^"]*"[^>]*>([^<]+)<\/a>/i);
    if (studioMatch?.[1]) {
      studio = studioMatch[1].trim();
    }

    debugLog('[JavDatabase] 提取結果:', { id: upperId, title, cover: cover?.substring(0, 50), actors, studio });

    if (!title && !actors.length && !studio) return null;

    return { id: upperId, title, cover, actors, studio, source: 'javdatabase' };
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[JavDatabase] 請求超時:', id);
    } else {
      console.error('[JavDatabase] fetch error:', e.message);
    }
    return null;
  }
}

// ========== JavMost 數據源 ==========
async function fetchJavmost(id) {
  try {
    const upperId = id.toUpperCase();
    debugLog('[JavMost] 請求:', upperId);

    const res = await fetchWithTimeout(
      `https://www.javmost.ws/${encodeURIComponent(upperId)}/`,
      getBrowserFetchOptions('https://www.javmost.ws/')
    );
    if (!res.ok) return null;

    const html = await res.text();
    debugLog('[JavMost] HTML 長度:', html.length);

    // 確認頁面確實有此番號（避免跳轉到首頁或搜尋頁）
    if (!html.includes(upperId) && !html.toLowerCase().includes(upperId.toLowerCase())) {
      debugLog('[JavMost] 頁面不含番號，跳過');
      return null;
    }

    // 提取封面（og:image）
    let cover = extractCover(html, [
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<img[^>]+src="([^"]+)"[^>]*class="[^"]*poster/i,
      /<img[^>]+src="([^"]+)"[^>]*id="[^"]*cover/i,
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*class="[^"]*img-fluid/i
    ]);

    // 提取片名
    let title = null;
    const titlePatterns = [
      /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i,
      /<h2[^>]*>\s*([^<]{10,})\s*<\/h2>/i,
      /<title>([^|<]+)/i
    ];
    for (const pattern of titlePatterns) {
      const m = html.match(pattern);
      if (m?.[1]) {
        title = m[1].trim()
          .replace(/\s*[-|]\s*Watch JAV.*$/i, '')
          .replace(/\s*[-|]\s*JAVMOST.*$/i, '')
          .replace(new RegExp('^' + upperId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*', 'i'), '')
          .trim();
        if (title && title.length > 3) break;
      }
    }

    // 提取女優（英文名，從 /star/ 連結）
    const actors = [];
    const starRegex = /<a[^>]*href="[^"]*\/star\/([^"]+)"[^>]*>([^<]+)<\/a>/gi;
    let m;
    while ((m = starRegex.exec(html)) !== null) {
      const name = decodeURIComponent(m[2]).trim();
      if (name && !actors.includes(name) && name.length > 1) {
        actors.push(name);
      }
      if (actors.length >= 5) break;
    }

    // 提取片商（Maker 欄位）
    let studio = null;
    const makerMatch = html.match(/Maker\s*<\/[^>]+>\s*<[^>]+>\s*([^<]+)/i) ||
                       html.match(/Maker[^<]*<\/\w+>\s*([A-Za-z0-9 .!']+)</i) ||
                       html.match(/maker[^:]*:\s*([^\n<,]+)/i);
    if (makerMatch?.[1]) {
      studio = makerMatch[1].trim();
    }

    debugLog('[JavMost] 提取結果:', { id: upperId, title, cover: cover?.substring(0, 50), actors, studio });

    if (!title && !actors.length && !studio) return null;

    return { id: upperId, title, cover, actors, studio, source: 'javmost' };
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[JavMost] 請求超時:', id);
    } else {
      console.error('[JavMost] fetch error:', e.message);
    }
    return null;
  }
}

// ========== MGStage (日本官方) 數據源 ==========
async function fetchMgstage(id) {
  try {
    const upperId = id.toUpperCase();
    debugLog('[MGStage] 請求:', upperId);
    
    // MGStage 搜索頁面
    const searchUrl = `https://www.mgstage.com/product/product_detail/${encodeURIComponent(upperId)}/`;
    debugLog('[MGStage] URL:', searchUrl);
    
    const res = await fetchWithTimeout(searchUrl, {
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja-JP',
        'Referer': 'https://www.mgstage.com/'
      }
    });
    
    if (!res.ok) {
      debugLog('[MGStage] 請求失敗:', res.status);
      return null;
    }
    
    const html = await res.text();
    debugLog('[MGStage] HTML 長度:', html.length);
    
    // 提取封面
    let cover = extractCover(html, [
      /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i,
      /<img[^>]+src="([^"]+cover[^"]*)"/i,
      /<img[^>]+src="([^"]+jacket[^"]*)"/i,
      /<img[^>]+src="([^"]+\.jpg[^"]*)"[^>]*class="[^"]*package/i
    ]);
    
    if (cover && !cover.startsWith('http')) {
      cover = 'https://www.mgstage.com' + cover;
    }
    
    // 提取女優 - MGStage 格式
    const actors = extractMgstageActors(html);
    
    debugLog('[MGStage] 提取結果:', { id: upperId, cover: cover?.substring(0, 50), actors: actors.length });
    
    if (!cover && !actors.length) return null;
    
    return { id: upperId, cover, actors, source: 'mgstage' };
  } catch (e) {
    if (isTimeoutError(e)) {
      console.warn('[MGStage] 請求超時:', id);
    } else {
      console.error('[MGStage] fetch error:', e.message);
    }
    return null;
  }
}

function extractMgstageActors(html) {
  const actors = [];
  
  // MGStage 女優提取 pattern
  const patterns = [
    /<a[^>]*href="[^"]*\/actor\/[^"]*"[^>]*>([^<]+)<\/a>/gi,
    /<span[^>]*class="[^"]*actor[^"]*"[^>]*>([^<]+)<\/span>/gi,
    /<td[^>]*>女優<\/td>\s*<td[^>]*>([^<]+)<\/td>/i
  ];
  
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(html)) !== null) {
      const name = m[1]?.trim();
      if (name && !name.includes('♂') && !actors.includes(name)) {
        actors.push(name);
      }
      if (actors.length >= 5) break;
    }
    if (actors.length >= 5) break;
  }
  
  debugLog('[MGStage] 找到女優:', actors);
  return actors;
}

// Service Worker 啟動時執行一次自檢，方便診斷 background fetch 是否正常
(async function selfTest() {
  const testId = 'IPX-333';
  debugLog('[Code] Service Worker 啟動自檢，測試番號:', testId);
  try {
    const result = await fetchCodeExists(testId);
    debugLog('[Code] 自檢結果:', testId, result ? '成功' : '失敗', result);
  } catch (e) {
    console.error('[Code] 自檢發生異常:', e.message);
  }
})();

})(); // IIFE 結束

