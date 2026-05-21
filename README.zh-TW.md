# 誰是臥底遊戲伺服器

[English](README.md)

這是一個即時網頁版 *誰是臥底* 派對遊戲伺服器。主持人可以建立房間大廳，用 QR Code 邀請玩家加入，在大廳調整角色數量，然後手動開始遊戲。伺服器負責分配詞語、投票流程、主持人踢人、白板猜詞、斷線重連與多語系顯示。

最新重點（v0.10.0）：
- 使用 React + Vite 重建主持人與玩家介面。
- 改為大廳優先流程：建立房間後立即顯示 QR Code，主持人可在大廳調整臥底、白板與人數上限，再手動開始遊戲。
- 主持人可在大廳移除玩家，也可在遊戲中將玩家踢出。
- 投票結果在數學上已無法被改變時，會提前結束投票。
- 遊戲結束時，主持人畫面會顯示大型結果、所有玩家角色與詞語，並高亮勝利者卡片。
- 支援英文與中文介面，語系資料位於 `public/i18n.json`。
- 加入連線、投票、結局與測試控制台的測試工具，目前 socket 整合測試涵蓋 25 個情境。

## 功能

- **Express + Socket.IO 後端**，支援即時房間狀態與主持人重新整理後恢復畫面。
- **React + Vite 前端**，正式環境由 `dist/` 提供靜態檔案；`/` 是主持人頁面，`/join/:roomId` 是玩家頁面。
- **題庫管理** 位於 `data/QuestionLib`，可透過主持人介面上傳 CSV，也可手動放入檔案。
- **主持人控制台** 支援建立房間、QR Code、角色設定、玩家踢出、投票、同步、語言設定與結束揭示。
- **玩家頁面** 支援手機使用、相機/圖片上傳、斷線重連、投票、白板猜詞與結局顯示。
- **圖片處理** 會在伺服器端透過 `sharp` 壓縮並存到 `data/Sections`。
- **白板猜詞流程** 會在白板出局時提示猜詞，猜中或猜錯後自動處理遊戲結果。
- **提前結束投票** 當剩餘玩家投票也無法改變領先者時，系統會立即結算。

## 專案結構

```text
main/
├── data/
│   ├── QuestionLib/   # CSV 題庫，第一列是題庫類型
│   └── Sections/      # 房間資料、玩家圖片與狀態檔
├── dist/              # 建置後的 React 前端
├── docs/              # 連線與投票/結局測試文件
├── public/
│   ├── i18n.json      # 介面語系字典
│   └── test-console.html
├── src/               # React/Vite 前端原始碼
├── tests/             # Socket 整合測試與測試控制台 smoke test
├── logic.js           # 角色分配輔助邏輯
├── server.js          # Express + Socket.IO 伺服器
├── Dockerfile
├── docker-compose.example.yml
└── package.json
```

## 本機開發

需求：
- Node.js 20+
- npm 9+

安裝與啟動：

```bash
npm install
npm run dev
```

或使用正式啟動方式：

```bash
npm start
```

伺服器預設監聽 `3000` port。主持人開啟：

```text
http://localhost:3000/
```

玩家透過主持人頁面產生的 QR Code 或 `/join/<ROOMID>` 加入。

前端開發模式：

```bash
npm run web:dev
```

正式前端建置：

```bash
npm run build:web
```

## 題庫與資料

題庫放在：

```text
data/QuestionLib
```

CSV 格式：
- 第一列：題庫類型
- 後續每列：`wordA,wordB`

遊戲房間、玩家圖片與房間狀態會存到：

```text
data/Sections/<ROOMID>
```

伺服器啟動時會清除舊房間資料，避免重啟後殘留過期房間。部署時請把整個 `data/` 掛載到持久化儲存，至少要保留 `data/QuestionLib`。

## Docker 部署

建立映像檔：

```bash
docker build -t undercover:0.10.0 .
```

直接執行：

```bash
docker run --name undercover \
  -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  undercover:0.10.0
```

也可以使用範例 Compose 檔：

```bash
cp docker-compose.example.yml docker-compose.yml
```

編輯 `docker-compose.yml`，把左邊的資料路徑改成你的伺服器資料夾。例如：

```yaml
volumes:
  - /mnt/UbuntuROCm/undercover/data:/app/data
```

啟動：

```bash
docker compose up -d
```

查看日誌：

```bash
docker logs -f undercover
```

如果你的系統仍使用舊版指令，請改用 `docker-compose`：

```bash
docker-compose up -d
```

## 不使用 Docker 部署

1. 在伺服器安裝 Node.js 20。
2. 執行 `npm ci`。
3. 執行 `npm run build:web`。
4. 複製或掛載 `data/`，並確保 `data/QuestionLib` 至少有一個 CSV 題庫。
5. 使用 `PORT=8080 node server.js` 啟動，並可放在 NGINX/Caddy 等反向代理後方。
6. 使用 PM2、systemd 或其他方式做程序監控。

## 測試

```bash
node --check server.js
npm run build:web
npm run test:console
npm run test:connectivity
```

整合測試涵蓋大廳手動開始、玩家重連、角色資訊保護、主持人踢人、提前投票結束、白板猜詞、結局判定與玩家名稱長度限制。

## Windows 輔助啟動

可雙擊 `start-server.bat` 啟動伺服器。測試控制台可使用 `start-tester.bat`。

