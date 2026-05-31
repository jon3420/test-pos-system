# 金流 API 設定頁 — fix16c-hotfix

## 8個 Provider
linepay / ecpay / newebpay / jkopay / pxpay / applepay / googlepay / creditcard_terminal

## 每張卡片欄位
啟用開關、模式(測試/正式)、Merchant ID、API Key、Secret Key、Webhook URL、Callback URL、儲存、測試連線

## 載入函式
`loadGatewayCards()` — switchSettingsTab('gateway') 時自動呼叫

## Webhook/Callback 預設 URL
`window.location.origin + '/webhook/{code}'`（不寫死網域）
