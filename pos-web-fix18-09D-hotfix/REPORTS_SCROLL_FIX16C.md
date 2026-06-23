# 報表頁滾動修正 — fix16c-hotfix

問題：`html, body { overflow: hidden }` + `.page { overflow: hidden }` 雙重鎖定，
`#page-reports` 未覆寫，報表內容超出時無法滾動。

修正：main.css 為 `#page-reports` 明確設 `overflow-y: auto`，
CSS specificity 覆蓋通用 `.page` 規則。
