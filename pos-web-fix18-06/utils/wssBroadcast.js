// utils/wssBroadcast.js — SaaS R1 fix6
// 所有 WebSocket broadcast 統一透過此模組發送，確保只廣播給同店家。
'use strict';

/**
 * broadcastToStore
 * 只發送給與 storeId 相同的 WebSocket client。
 *
 * @param {WebSocketServer} wss       - app.get('wss') 取得的 WSS 實例
 * @param {string}          storeId   - 目標店家 ID
 * @param {object}          payload   - 要廣播的 JSON payload（會自動加上 store_id）
 */
function broadcastToStore(wss, storeId, payload) {
  if (!wss || !storeId) return;
  const msg = JSON.stringify({ ...payload, store_id: storeId });
  let sent = 0;
  wss.clients.forEach(client => {
    if (client.readyState === 1 && client.storeId === storeId) {
      client.send(msg);
      sent++;
    }
  });
  // 開發環境 debug log（可在 production 關閉）
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[WSS] broadcastToStore store=${storeId} type=${payload.type} sent=${sent}`);
  }
}

module.exports = { broadcastToStore };
