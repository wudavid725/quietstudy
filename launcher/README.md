# Shy Safari 啟動器

給「重開機就清空、只保留某個磁碟」的教室電腦用。瀏覽器的設定檔（擴充功能、Chrome 登入、Shy Safari 的紀錄）都放在這個資料夾裡，重開機也不會消失。每次開啟前會自動從 GitHub 下載最新版的擴充功能。

自己的電腦也可以用同樣的方式，放在任何資料夾都行。

## 第一次設定（每台電腦做一次）

1. 從 GitHub 下載這個專案（Code → Download ZIP），把 `launcher` 資料夾裡的兩個檔案複製到會保留資料的磁碟，例如 `E:\ShySafari\`：
   - `開啟 Shy Safari.cmd`
   - `launcher.ps1`
2. 雙擊 `開啟 Shy Safari.cmd`。它會下載擴充功能到 `E:\ShySafari\extension`，然後開啟一個新的 Chrome 視窗。
3. 在這個新視窗裡：
   1. 登入你的 Chrome 帳號，並開啟同步，同步項目要包含「擴充功能」。
   2. 網址列輸入 `chrome://extensions`，打開右上角的「開發人員模式」。
   3. 按「載入未封裝項目」，選 `E:\ShySafari\extension`。
   4. 確認 ID 是 `jpagpbhiilhaoccfinomjekkcnldmmfh`。
   5. 按拼圖圖示，把「Shy Safari 自動同步」釘選到工具列。

設定都存在 `E:\ShySafari\profile`，之後重開機也會保留。

## 每天使用

雙擊 `E:\ShySafari\開啟 Shy Safari.cmd`。它會先檢查有沒有新版本，再開啟 Shy Safari。

- 請用這個捷徑開啟，不要用電腦原本的 Chrome 圖示。原本的 Chrome 每次重開機都會被清空，裡面沒有擴充功能。
- 沒有網路或 GitHub 連不上時，會用 E 槽裡現有的版本照常開啟。
- 如果這個視窗已經開著時有新版本，擴充功能會等你關掉 Shy Safari 分頁後自己更新。

## 注意事項

- 找不到 Chrome 時會改用 Edge。Edge 的登入和同步是 Microsoft 帳號，跟 Chrome 不互通，所以建議所有電腦都用 Chrome。
- Chrome 登入的狀態存在 E 槽，其他人用這個捷徑開啟，也會用你的帳號。
- 如果學校擋住了 PowerShell，雙擊後會沒有反應或閃一下就關掉，請問資訊組。
- 從 GitHub 自動下載需要專案是公開的。
