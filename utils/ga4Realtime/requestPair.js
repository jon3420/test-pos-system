// utils/ga4Realtime/requestPair.js — fix18-10-hotfix30-B5-R5.4-G1.5-B2.4
// GA4 Realtime — Summary／City 分階段執行 + 安全診斷 Log（見需求文件四）。
//
// 單一實作供 utils/ga4Realtime/index.js（正式資料 Endpoint，含 retry）與
// utils/ga4Realtime/connectionTest.js（Connection Test，不 retry）共用，
// 避免兩處各自維護一份「Summary/City 平行呼叫」邏輯而彼此走樣。
//
// 邊界（不得違反，見需求文件四）：
//   - 呼叫端負責先用 requestBuilder.js 組好 summaryRequest／cityRequest
//     （本檔案不知道、也不處理 propertyId／streamId 是否合法）。
//   - runFn(request) 是實際執行單一 Request 的函式（由呼叫端注入，可以是
//     裸 ga4Client.runGa4RealtimeReport，也可以是包了 retry 的版本）。
//   - Server Log 只能記錄 stage／code／retryable／window／metric／
//     elapsed_ms，不得記錄 Property／Stream／Credential／Raw Google
//     Error／Raw Response（見需求文件四、八）。

'use strict';

function _logStage(stage, result, windowMinutes, metric, elapsedMs) {
  const code = result && result.ok ? 'OK' : ((result && result.code) || 'UNKNOWN');
  const retryable = !!(result && result.retryable);
  // eslint-disable-next-line no-console
  console.log(`[ga4-realtime] stage=${stage} code=${code} retryable=${retryable} window=${windowMinutes} metric=${metric} elapsed_ms=${elapsedMs}`);
}

// runGa4RealtimeRequestPair({ summaryRequest, cityRequest, windowMinutes, metric, runFn })
//   → { summaryResult, cityResult, summaryRequest, cityRequest }
//
// summaryRequest／cityRequest 若為 null（呼叫端 builder 失敗時就不該呼叫
// 這個函式，但這裡仍防禦性處理，回傳 ok:false/invalid_request，不丟例外）。
async function runGa4RealtimeRequestPair({ summaryRequest, cityRequest, windowMinutes, metric, runFn }) {
  const run = async (stage, request) => {
    if (!request) {
      const result = { ok: false, code: 'invalid_request', retryable: false };
      _logStage(stage, result, windowMinutes, metric, 0);
      return result;
    }
    const startedAt = Date.now();
    const result = await runFn(request);
    _logStage(stage, result, windowMinutes, metric, Date.now() - startedAt);
    return result;
  };

  const [summaryResult, cityResult] = await Promise.all([
    run('summary', summaryRequest),
    run('city', cityRequest),
  ]);

  return { summaryResult, cityResult, summaryRequest, cityRequest };
}

module.exports = {
  runGa4RealtimeRequestPair,
};
