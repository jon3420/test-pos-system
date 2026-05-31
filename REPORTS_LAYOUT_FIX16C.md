# 報表分析版面修正 — fix16c-hotfix

## CSS 問題根源
`.page { overflow: hidden }` + `#page-reports` 未設 `overflow-y: auto`
導致內容超出時無法滾動，且內層 wrapper 設有 `max-width: 960px; margin: 0 auto` 造成窄欄。

## 修正
main.css 新增：
```css
#page-reports { overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; }
#reports-container { width: 100%; flex: 1; padding: 24px; box-sizing: border-box; }
```

index.html：移除 `max-width:960px` wrapper，直接用 `#reports-container`。

app.js `_section()` 加 `width:100%;box-sizing:border-box`。

卡片 Grid 改為 `repeat(auto-fill, minmax(160px, 1fr))`，響應式。
