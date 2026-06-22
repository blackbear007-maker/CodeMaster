// 番號大師 - 工具函數模組
(function() {
'use strict';

// 調試模式（生產環境設為 false）
const DEBUG_MODE = false;
const debugLog = DEBUG_MODE ? console.log : () => {};

// 安全工具函數
const SecurityUtils = {
  // OWASP 標準 HTML 轉義
  escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  // 驗證番號格式
  validateBangoId(id) {
    if (!id || typeof id !== 'string') return false;
    const bangoPattern = /^[A-Za-z]{2,8}[-－]?\d{2,5}$/;
    return bangoPattern.test(id.trim());
  },

  // 驗證文本長度
  validateTextLength(text, maxLength = 200) {
    return !text || typeof text !== 'string' || text.length > maxLength ? '' : text.trim();
  },

  // 安全地設置 HTML 內容
  safeSetHTML(element, content) {
    if (!element) return;
    element.textContent = content;
  }
};

// 錯誤處理工具
const ErrorHandler = {
  // 記錄錯誤但不暴露敏感信息
  log(error, context = '') {
    const safeError = {
      message: error.message || 'Unknown error',
      context,
      timestamp: new Date().toISOString()
    };
    console.warn('[Bango Error]', safeError);
  },
  
  // 處理擴充功能上下文錯誤
  handleExtensionError(error, fallbackMessage = '擴充功能暫時無法使用') {
    this.log(error, 'Extension Context');
    return {
      success: false,
      error: fallbackMessage,
      needsReload: true
    };
  },
  
  // 處理網路錯誤
  handleNetworkError(error) {
    this.log(error, 'Network');
    return {
      success: false,
      error: '網路連線問題，請稍後再試'
    };
  },
  
  // 處理解析錯誤
  handleParseError(error) {
    this.log(error, 'Parse');
    return {
      success: false,
      error: '資料解析失敗'
    };
  }
};

// 重試機制
const retryWithBackoff = async (fn, maxRetries = 3, baseDelay = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      const delay = baseDelay * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
};

// DOM 工具函數
const DOMUtils = {
  // 安全地創建元素
  createElement(tag, className = '', textContent = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (textContent) element.textContent = textContent;
    return element;
  },

  // 安全地設置樣式
  setStyles(element, styles) {
    if (!element || typeof styles !== 'object') return;
    Object.assign(element.style, styles);
  },

  // 檢查元素是否在視野中
  isElementVisible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
};

// 導出模組
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SecurityUtils,
    ErrorHandler,
    retryWithBackoff,
    DOMUtils,
    debugLog,
    DEBUG_MODE
  };
}

})(); // IIFE 結束
