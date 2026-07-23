// public/js/delivery-free-progress.js — C3
// 外送滿額免運進度提示 — 純函式（不碰 DOM），供 public/line-order.html 與
// scripts/smoke-delivery-free-progress.js / scripts/smoke-delivery-distance-promotion.js
// 共用同一份邏輯，避免 UI 與測試漂移。
//
// C3 變更重點：不再自己假設「全店只有一個滿額門檻」，改成直接吃後端
// routes/delivery.js（calculateDeliveryFeeWithPromotion() 的回傳結果）算好的
// 「這次距離命中的級距」資訊：threshold / mode / rawDeliveryFee / finalDeliveryFee
// 全部來自呼叫端傳入的後端結果，這裡只負責純文案/狀態組裝，不重算、不猜測。
//
// 參數口徑：
//   eligibleSubtotal — 免運門檻判斷金額（優惠券折扣前，與後端 eligibleSubtotal 口徑一致）。
//   threshold        — 這次命中級距實際適用的滿額門檻（可能來自級距自己的設定，也可能是
//                       legacy fallback 全店門檻；呼叫端已經處理好優先序，這裡直接使用）。
//   mode             — 'none' | 'full' | 'fixed'。決定文案樣板。
//   rawDeliveryFee / finalDeliveryFee — 皆為 null 表示外送費尚未算出（地址還沒確認/計算中）。
//                       finalDeliveryFee 若為負數會被正規化為 0。
//   reached          — 後端回傳的「金額是否已達門檻」（free_rule_applied）。
//   remaining        — 距門檻還差多少（後端算好的 remaining_for_free_delivery，或本地用
//                       threshold - eligibleSubtotal 推算皆可，呼叫端保證口徑一致）。
//   isOutOfRange     — 地址超過本店最大外送距離／超過所有級距設定範圍。優先序最高：
//                       超距離時一律顯示警示狀態，不得顯示「已達免運資格」等成功文案，
//                       reached 一律視為 false。
//   feeResolved      — true 表示「rawDeliveryFee/finalDeliveryFee 已經是後端真實計算結果」；
//                       false／未提供表示金額已達門檻但外送費還沒算出來（例如地址還沒選
//                       好座標），此時只能說「已達滿額門檻」，不能宣告「已達免運資格」——
//                       是否真的免運/折抵多少，一律以後端計算結果為準，這裡絕不能提前
//                       替後端下結論。
function getDeliveryFreeProgressState(params) {
  const {
    eligibleSubtotal,
    threshold,
    mode,
    rawDeliveryFee = null,
    finalDeliveryFee = null,
    reached: reachedFromBackend = null,
    remaining: remainingFromBackend = null,
    isDelivery,
    isOutOfRange = false,
    feeResolved = false,
  } = params || {};

  const fmt = (n) => `NT$${Math.round(n).toLocaleString('en-US')}`;
  const th = Number(threshold) || 0;
  const promoMode = (mode === 'full' || mode === 'fixed') ? mode : 'none';

  // 未啟用（mode==='none'）／門檻無效／非外送模式：完全隱藏。
  if (!isDelivery || promoMode === 'none' || th <= 0) {
    return {
      visible: false, reached: false, nearThreshold: false, remaining: 0, progressPercent: 0,
      headline: '', description: '', currentAmountText: '', thresholdAmountText: '',
      savedAmount: null, finalDeliveryFee: null, isOutOfRange: false,
    };
  }

  const sub = Math.max(Number(eligibleSubtotal) || 0, 0);
  const remaining = remainingFromBackend != null ? Math.max(Number(remainingFromBackend) || 0, 0) : Math.max(th - sub, 0);
  const reachedByAmount = reachedFromBackend != null ? !!reachedFromBackend : sub >= th;
  const progressPercent = Math.round(Math.min(Math.max((sub / th) * 100, 0), 100));
  const nearThreshold = !reachedByAmount && progressPercent >= 80;
  const currentAmountText = fmt(sub);
  const thresholdAmountText = fmt(th);

  // ── 優先序最高：超距離。不得顯示可送單的「已達免運」成功狀態。──
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
      description = `再消費 ${fmt(remaining)} 即可${promoMode === 'full' ? '免運' : '達成'}`;
    } else if (promoMode === 'full') {
      headline = '🎁 滿額外送優惠';
      description = `滿 ${thresholdAmountText} 享免運\n再消費 ${fmt(remaining)} 即可免運`;
    } else {
      // fixed：未達門檻時，折抵金額用「設定值」顯示（即使 feeResolved 尚未算出實際
      // rawFee，前端呼叫端會把設定的 free_discount_value 當作 rawDeliveryFee 傳進來，
      // 由呼叫端保證口徑；這裡只負責顯示）。
      const znText = normRawFee != null ? fmt(normRawFee) : '';
      headline = '🎁 滿額外送優惠';
      description = znText
        ? `滿 ${thresholdAmountText} 折抵 ${znText} 外送費\n再消費 ${fmt(remaining)} 即可達成`
        : `滿 ${thresholdAmountText} 折抵外送費\n再消費 ${fmt(remaining)} 即可達成`;
    }
  } else if (!feeResolved) {
    // 金額已達門檻，但外送費尚未算出（地址還沒選好座標）：不得宣告已免運/已折抵。
    headline = '🎁 已達滿額門檻';
    description = '外送費將於確認地址後計算折抵';
  } else if (normRawFee != null && normRawFee <= 0) {
    // 原始外送費本來就是 0：不得顯示「已折抵 NT$0」。
    headline = '🎉 已達滿額外送優惠';
    description = '';
  } else if (promoMode === 'full') {
    headline = '🎉 已達免運資格';
    savedAmount = (normRawFee != null && normFinalFee != null) ? Math.max(normRawFee - normFinalFee, 0) : null;
    description = savedAmount != null ? `本次已免 ${fmt(savedAmount)} 外送費` : '本次已免外送費';
  } else {
    // fixed 已達且 feeResolved
    headline = '🎉 已達滿額外送優惠';
    if (normRawFee != null && normFinalFee != null) {
      savedAmount = Math.max(normRawFee - normFinalFee, 0);
      description = normFinalFee > 0
        ? `本次折抵 ${fmt(savedAmount)}\n仍需支付 ${fmt(normFinalFee)} 外送費`
        : `本次折抵 ${fmt(savedAmount)} 外送費`;
    } else {
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
