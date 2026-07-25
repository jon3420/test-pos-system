# RC1 Release Notes
## fix18-10-hotfix30-B5-R5.2-A-RC1

Release Candidate 1 — Taiwan Administrative Area Intelligence 正式封版。

本文件僅整理封版所需的驗收摘要與版本資訊；完整功能說明、API 支援矩陣、
逐項已知限制請見 [`docs/R5.2-A-completion.md`](./R5.2-A-completion.md)
（本文件不重寫其內容，僅引用重點）。

## 完成功能

引用自 `docs/R5.2-A-completion.md` 第 2 節「Completed Modules」，完整清單：

- Taiwan administrative dataset（22 縣市／368 鄉鎮市區，manifest + SHA-256 checksum）
- County/Subdivision Normalization
- Filter validator（`validateAreaFilters()`）
- `resolveStoredArea()`（acquisition／fulfillment context 隔離的統一解析）
- Unified area enrichment（8 個統一欄位：`county_code` / `county_name` /
  `subdivision_code` / `subdivision_name` / `subdivision_type` /
  `area_key` / `area_label` / `resolution`）
- `/overview`、`/funnel` area filtering（篩選後全部 KPI 一併重算）
- `/fulfillment` Fulfillment Geo Analytics
- `/county-summary`、`/source-area`、`/cart-attribution`
- Mixed-context `/alerts`
- Order Fulfillment Geo Write（LINE 外送／宅配）
- Business Area Reserved Columns（僅保留，未啟用）
- Migration compatibility（安全 idempotent migration）
- Privacy protection、Store isolation

詳細 API 支援矩陣（哪支 API 支援 `county_code`／`subdivision_code`／
`geo_context`／unified shape）見 `docs/R5.2-A-completion.md` 第 3 節。

## Regression

```
13 suites PASS
0 new regressions
```

逐份列出：

| Suite | 結果 |
|---|---|
| Stage 7（`smoke-hotfix30-b5-r5-2-a-stage7.js`） | 140/140 PASS |
| Stage 8（`smoke-hotfix30-b5-r5-2-a-order-geo-write.js`） | 90/90 PASS |
| Stage 9（`smoke-hotfix30-b5-r5-2-a-business-area-reserved.js`） | 62/62 PASS |
| Stage 10（`smoke-hotfix30-b5-r5-2-a-integrated.js`） | 230/230 PASS |
| R5.1-A | 76/76 PASS |
| R5.1-B | 111/111 PASS |
| R5.1-C | 182/182 PASS |
| R5.1-D1 | 164/164 PASS |
| cart-order-hours | 110/110 PASS |
| dashboard-ui | 40/40 PASS |
| debounce | 32/32 PASS |
| r4-channel-visitor360 | 116/116 PASS |
| r4-1-ui-fixes | 80/80 PASS |

## Known Limitations

（完整版見 `docs/R5.2-A-completion.md` 第 7 節，此處僅摘要）

- `routes/orders.js`（POS/後台人工建單）未寫入履約行政區代碼——僅有原始
  `delivery_address` 字串或第三方外送平台 payload，沒有可靠結構化來源，
  本輪原則是「沒有結構化來源就不猜地址」。
- `routes/sync.js`（POS 裝置訂單匯入）同樣未寫入，原因相同。
- Business Area（商圈）欄位僅保留（reserved），本輪完全未啟用——沒有
  writer、沒有 reader、沒有 API、沒有 UI。
- 訂單建立目前沒有明確的多語句 transaction（BEGIN/COMMIT/ROLLBACK）包裹。
- `orders.items` 是 JSON blob 欄位，不是獨立的 `order_items` 資料表。
- 郵遞區號輔助解析（postal-code auxiliary resolution）：NOT IMPLEMENTED。
- 地圖視覺化（GeoJSON／Leaflet／行政區底圖著色／熱區圖）尚未實作，規劃於
  下一個大型版本 R5.2-B。

## Future Roadmap — R5.2-B｜Geo Intelligence Map

本輪（RC1）**不開始實作**，僅列出規劃方向：

- Leaflet Map（行政區底圖）
- Heatmap（訪客／購物車／成交熱區視覺化）
- Business Area（商圈分析——啟用 R5.2-A 已保留的 `business_area_code` /
  `business_area_name` 欄位）
- Map Dashboard（地圖版 Dashboard 卡片）
- Distance Visualization（外送距離圈視覺化）
- Polygon Analysis（行政區/商圈邊界疊圖分析）

## Version

```
fix18-10-hotfix30-B5-R5.2-A-RC1
```

`package.json` / `package-lock.json` 版本欄位已同步更新為
`18.30.0-R5.2-A-RC1`。
