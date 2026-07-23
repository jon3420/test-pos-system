// public/js/delivery-free-progress.js
// 外送滿額免運進度提示 — 純函式（不碰 DOM），供 public/line-order.html 與
// scripts/smoke-delivery-free-progress.js 共用同一份邏輯，避免 UI 與測試漂移。
//
// 參數口徑：
//   eligibleSubtotal — 免運門檻判斷金額。與後端一致：目前 routes/delivery.js
//     calcFee() 與 routes/line-orders.js recalcDeliveryFee() 判斷免運門檻時，用的都是
//     「優惠券折扣前」的商品小計（見 fetchDeliveryFee() 呼叫 /api/delivery/calculate-fee
//     時傳入的 subtotal，以及下單時 line-orders.js 的 sub 變數）。呼叫端（line-order.html
//     的 updateDeliveryFreeProgress()）必須傳入同一口徑，這裡不重複計算、不做假設。
//   isFreeDelivery — true/false/null。null 表示外送費尚未算出（例如地址還沒確認/計算中）。
//   rawDeliveryFee / finalDeliveryFee — 皆為 null 表示外送費尚未算出。finalDeliveryFee
//     若為負數會被正規化為 0（防止上游资料異常時顯示負的外送費或不合理折抵金額）。
//   isOutOfRange — 地址超過本店最大外送距離。優先序最高：超距離時一律顯示警示狀態，
//     不得顯示「已達免運資格」等成功文案，也不得標記為 reached（避免看起來可以送單）。
//   mode — 'full' | 'distance_only'，可省略。只影響「尚未達門檻」時的標題文案（是否
//     暗示達標後只折抵基本費）；「已達門檻」的實際文案一律依 isFreeDelivery／
//     rawDeliveryFee／finalDeliveryFee 的真實計算結果決定，不依賴這個 mode 假設折抵金額。
function getDeliveryFreeProgressState(params) {
  const {
    eligibleSubtotal,
    threshold,
    enabled,
    isFreeDelivery = null,
    rawDeliveryFee = null,
    finalDeliveryFee = null,
    isDelivery,
    isOutOfRange = false,
    mode,
  } = params || {};

  const fmt = (n) => `NT$${Math.round(n).toLocaleString('en-US')}`;
  const th = Number(threshold) || 0;

  // 未啟用 / 門檻無效 / 非外送模式：完全隱藏（狀態 A）。
  if (!isDelivery || !enabled || th <= 0) {
    return {
      visible: false, reached: false, nearThreshold: false, remaining: 0, progressPercent: 0,
      headline: '', description: '', currentAmountText: '', thresholdAmountText: '',
      savedAmount: null, finalDeliveryFee: null, isOutOfRange: false,
    };
  }

  const sub = Math.max(Number(eligibleSubtotal) || 0, 0);
  const remaining = Math.max(th - sub, 0);
  const reachedByAmount = sub >= th;
  const progressPercent = Math.round(Math.min(Math.max((sub / th) * 100, 0), 100));
  const nearThreshold = !reachedByAmount && progressPercent >= 80;
  const currentAmountText = fmt(sub);
  const thresholdAmountText = fmt(th);

  // ── 優先序最高：超距離。不得顯示可送單的「已達免運」成功狀態（第七項）。──
  if (isOutOfRange) {
    return {
      visible: true,
      reached: false,
      nearThreshold,
      remaining,
      progressPercent,
      headline: '⚠️ 超出配送範圍',
      description: '滿額優惠不適用於超出配送範圍的地址',
      currentAmountText,
      thresholdAmountText,
      savedAmount: null,
      finalDeliveryFee: finalDeliveryFee != null ? Math.max(Number(finalDeliveryFee) || 0, 0) : null,
      isOutOfRange: true,
    };
  }

  let headline, description, savedAmount = null;
  // 費用防負數：finalDeliveryFee 一律正規化為 >= 0 再參與計算與顯示。
  const normFinalFee = finalDeliveryFee != null ? Math.max(Number(finalDeliveryFee) || 0, 0) : null;
  const normRawFee = rawDeliveryFee != null ? Math.max(Number(rawDeliveryFee) || 0, 0) : null;

  if (!reachedByAmount) {
    if (nearThreshold) {
      headline = '🔥 就差一點！';
      description = `再消費 ${fmt(remaining)} 即可免運`;
    } else {
      headline = '🎁 滿額外送優惠';
      description = mode === 'distance_only'
        ? `滿 ${thresholdAmountText} 折抵基本外送費\n再消費 ${fmt(remaining)} 即可享優惠`
        : `滿 ${thresholdAmountText} 享免運\n再消費 ${fmt(remaining)} 即可免運`;
    }
  } else {
    const feeKnown = normRawFee != null && normFinalFee != null;
    if (!feeKnown) {
      // 尚未取得後端 /api/delivery/calculate-fee 結果（例如地址還沒輸入完成/尚未定位）：
      // 只能說「商品金額已達門檻」，不得宣告「已達免運資格」——外送費是否真的減免，
      // 一律以後端計算結果為準，這裡絕不能提前替後端下結論。
      headline = '🎁 已達滿額門檻';
      description = '外送費將於確認地址後計算折抵';
    } else if (normRawFee <= 0) {
      // 原始外送費本來就是 0：不得顯示「已折抵 NT$0」（狀態 D 附則）。
      headline = '🎉 已達滿額外送優惠';
      description = '';
    } else if (isFreeDelivery) {
      headline = '🎉 已達免運資格';
      savedAmount = Math.max(normRawFee - normFinalFee, 0);
      description = `本次已折抵 ${fmt(savedAmount)} 外送費`;
    } else if (normFinalFee < normRawFee) {
      // 只折抵部分外送費（狀態 E：例如只折基本費，超距離費仍需支付）。
      // 折抵金額一律用 rawFee - finalFee 實際差額計算，不假設等於 delivery_basic_fee。
      headline = '🎉 已達滿額外送優惠';
      savedAmount = Math.max(normRawFee - normFinalFee, 0);
      description = `本次已折抵 ${fmt(savedAmount)} 外送費\n仍需支付 ${fmt(normFinalFee)} 超距離費`;
    } else {
      headline = '🎉 已達滿額外送優惠';
      description = '';
    }
  }

  return {
    visible: true,
    reached: reachedByAmount,
    nearThreshold,
    remaining,
    progressPercent,
    headline,
    description,
    currentAmountText,
    thresholdAmountText,
    savedAmount,
    finalDeliveryFee: normFinalFee,
    isOutOfRange: false,
  };
}

// UMD-lite：瀏覽器 <script> 載入時掛在 window，Node (regression test) 用 module.exports。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getDeliveryFreeProgressState };
}
if (typeof window !== 'undefined') {
  window.getDeliveryFreeProgressState = getDeliveryFreeProgressState;
}
