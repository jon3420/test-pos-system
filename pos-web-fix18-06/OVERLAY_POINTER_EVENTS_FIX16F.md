# Overlay Pointer Events — fix16f

## hideLoginOverlay() 修正
```js
overlay.style.display = 'none';
overlay.style.visibility = 'hidden';
overlay.style.pointerEvents = 'none';  // 確保不攔截點擊
overlay.style.zIndex = '-1';           // 沉到最底層
```
