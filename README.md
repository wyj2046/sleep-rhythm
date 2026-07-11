# 晨昏记

一个无构建步骤的睡眠节律记录工具，用来记录每天的入睡、起床时间，查看全部历史趋势，并标记明显波动。

## 使用

建议在项目目录启动一个本地静态服务器：

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

然后打开 `http://127.0.0.1:8765/`。

趋势页默认展示全部日期：顶部是完整历史概览，下方按最近月份优先分章；缺失日期仍保留时间位置，但折线会跨过缺失日连续展示，7 日中位数可独立开关。新用户的默认目标起床时间为 06:30；修改目标起床时间时，未进入编辑状态的记录表单会同步采用新默认值。

建议定期点击右上角导出 JSON，作为备份；CSV 适合拿到 Excel 或 Numbers 里继续分析。

## Firebase 云同步

这版支持可选的 Firebase 云同步。登录并成功读取后，以 Firebase 远端快照为事实源；`localStorage` 仅作为离线缓存和明确待同步操作的队列。读取远端不会根据本地缺失项删除或整包覆盖云端数据。未配置 Firebase 时，应用继续使用本地保存。

### Firebase 控制台

1. 创建 Firebase 项目。
2. 添加 Web App，复制 `firebaseConfig`。
3. 启用 Authentication，并开启 Google 登录。
4. 在 Authentication 的授权域名里加入 `wyj2046.github.io`。
5. 创建 Cloud Firestore 数据库。
6. 将 `firestore.rules` 里的规则发布到 Firestore Rules。
7. 把 `firebase-config.js` 改成你的配置。

`firebase-config.js` 的格式可以参考 `firebase-config.example.js`。

## 检查

```bash
node --check app.js
node --check trend-core.js
node --test tests/*.test.cjs
git diff --check
```
