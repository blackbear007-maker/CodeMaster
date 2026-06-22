// 番號大師 - Popup Script
(function() {

const toggleEnabled = document.getElementById('toggle-enabled');
const toggleHover = document.getElementById('toggle-hover');
const btnClearCache = document.getElementById('btn-clear-cache');
const statusMsg = document.getElementById('status-msg');

// 檢查元素是否存在
if (toggleEnabled && toggleHover && btnClearCache && statusMsg) {
  // 元素存在，初始化功能

function showStatus(msg, color = '#22c55e') {
  statusMsg.style.color = color;
  statusMsg.textContent = msg;
  
  // 清除上個計時器
  if (showStatus.timeout) clearTimeout(showStatus.timeout);
  showStatus.timeout = setTimeout(() => { 
    if (statusMsg) statusMsg.textContent = ''; 
  }, 2000);
}

// 讀取設定（帶錯誤處理）
chrome.storage.local.get(['codeEnabled', 'codeHover'], (res) => {
  if (chrome.runtime.lastError) {
    console.error('Storage read failed:', chrome.runtime.lastError);
    showStatus('讀取設定失敗', '#ef4444');
    return;
  }
  
  toggleEnabled.checked = res.codeEnabled !== false;
  toggleHover.checked = res.codeHover !== false;
});

// 儲存設定（帶錯誤處理）
toggleEnabled.addEventListener('change', () => {
  chrome.storage.local.set({ codeEnabled: toggleEnabled.checked }, () => {
    const err = chrome.runtime.lastError;
    showStatus(
      err ? '儲存失敗' : (toggleEnabled.checked ? '偵測已啟用' : '偵測已停用'),
      err ? '#ef4444' : (toggleEnabled.checked ? '#22c55e' : '#888')
    );
  });
});

toggleHover.addEventListener('change', () => {
  chrome.storage.local.set({ codeHover: toggleHover.checked }, () => {
    const err = chrome.runtime.lastError;
    showStatus(
      err ? '儲存失敗' : (toggleHover.checked ? 'Hover 查詢已啟用' : 'Hover 查詢已停用'),
      err ? '#ef4444' : (toggleHover.checked ? '#22c55e' : '#888')
    );
  });
});

// 帶超時的 sendMessage
function sendMessageWithTimeout(message, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ success: false, error: 'Request timeout' });
    }, timeout);
    
    chrome.runtime.sendMessage(message, (res) => {
      clearTimeout(timer);
      resolve(res || { success: false, error: chrome.runtime.lastError?.message || 'Unknown error' });
    });
  });
}

// 清除快取（帶錯誤處理與超時）
btnClearCache.addEventListener('click', async () => {
  btnClearCache.disabled = true;
  
  const res = await sendMessageWithTimeout({ type: 'CLEAR_CACHE' }, 3000);
  
  btnClearCache.disabled = false;
  
  if (res?.success) {
    showStatus(`已清除 ${res.removed || 0} 筆快取`);
  } else {
    showStatus(res?.error || '清除失敗', '#ef4444');
  }
});

} // if 區塊結束

})(); // IIFE 閉合
