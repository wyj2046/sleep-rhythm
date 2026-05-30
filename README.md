# 睡眠起床时间记录

一个本地网页小工具，用来记录每天的入睡、起床时间，查看趋势，并标记明显波动。

## 使用

直接打开 `index.html` 即可。数据保存在当前浏览器的 `localStorage` 中。

建议定期点击右上角导出 JSON，作为备份；CSV 适合拿到 Excel 或 Numbers 里继续分析。

## Firebase 云同步

这版支持可选的 Firebase 云同步。未配置 Firebase 时，应用会继续使用本地保存。

### Firebase 控制台

1. 创建 Firebase 项目。
2. 添加 Web App，复制 `firebaseConfig`。
3. 启用 Authentication，并开启 Google 登录。
4. 在 Authentication 的授权域名里加入 `wyj2046.github.io`。
5. 创建 Cloud Firestore 数据库。
6. 将 `firestore.rules` 里的规则发布到 Firestore Rules。
7. 把 `firebase-config.js` 改成你的配置。

`firebase-config.js` 的格式可以参考 `firebase-config.example.js`。
