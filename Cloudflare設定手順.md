# 予約システム Cloudflare 設定手順

このブランチは、今のHPに予約画面・管理画面・精算を組み込み、Netlify を使わずに Cloudflare Pages で動かすものです。
データベースは今の Neon をそのまま使います。接続情報と秘密の値は GitHub に入れていません。下の環境変数に設定してください。

## 公開されるURL

| URL | 内容 |
|---|---|
| `/reserve/` | 予約画面（お客様用） |
| `/reserve/admin` | 管理画面（オーナー・スタッフ用） |
| `/reserve/admin/line-customers` | LINE顧客管理 |
| `/reserve/api/...` | 裏側の処理 |

## 1. プラン

**Workers の有料プラン（月5ドルから）が必要です。** 無料プランは1回の処理の計算時間が10ミリ秒までで、オーナーのパスワード確認と毎朝の処理がこの上限を超える見込みです。Pages の裏側の処理も同じ上限です。

## 2. Pages の設定

Settings → Runtime

- Compatibility date：`2026-10-01`
- Compatibility flags：`nodejs_compat`

本番（Production）とプレビュー（Preview）の両方に設定してください。

## 3. 環境変数（Pages の Settings → Variables and Secrets）

値は、かずやから安全な方法で受け取ってください。秘密の値は「Secret」で登録します。

| 名前 | 内容 | 種類 |
|---|---|---|
| `DATABASE_URL` | Neon の接続先 | Secret |
| `ADMIN_JWT_SECRET` | ログインの署名用（32文字以上） | Secret |
| `ADMIN_SETUP_TOKEN` | 初期設定用 | Secret |
| `ADMIN_RECOVERY_EMAIL` | パスワード再設定の送り先 | 通常 |
| `DISCORD_WEBHOOK_URL` | お店の Discord 通知 | Secret |
| `GAS_MAIL_URL` | メール・シート用の GAS の URL | Secret |
| `GAS_MAIL_TOKEN` | GAS の合言葉 | Secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | お店の公式LINE | Secret |
| `LINE_CHANNEL_SECRET` | お店の公式LINE | Secret |
| `OUTBOUND_DELIVERY_ENABLED` | **本番だけ** `true`。プレビューには設定しない | 通常 |
| `SITE_ORIGIN` | 公開URL（例：`https://example.com`、最後の `/` なし） | 通常 |
| `CRON_SECRET` | 毎朝の処理の合言葉（長いランダムな文字列） | Secret |
| `MAI_LINE_TOKEN` | エラー通知用のLINE | Secret |
| `MAI_LINE_TO` | エラー通知の宛先 | Secret |

**プレビューの `DATABASE_URL` は、本番と別にしてください。** 同じにすると、試験の予約や精算が本物のデータに混ざります。Neon のブランチ機能で試験用のコピーを作り、その接続先を設定します。

`OUTBOUND_DELIVERY_ENABLED` が無いと、メール・Discord・シートへの送信は全部止まります。

## 4. 毎朝8時の処理（Worker を1つ追加）

Pages には定期実行が無いので、`cron-worker/` を別の Worker として公開します。

```bash
cd cron-worker
npx wrangler deploy
npx wrangler secret put CRON_SECRET     # Pages と同じ値
npx wrangler secret put MAI_LINE_TOKEN
npx wrangler secret put MAI_LINE_TO
```

Worker の変数に `SITE_ORIGIN`（公開URL）も設定してください。**切り替えが終わるまで、この Worker は動かさないでください。** Netlify の毎朝の処理と同時に動くと、リマインドメールやシート更新が二重になります。

## 5. 本番への切り替え（確認が終わってから）

1. Netlify 側の毎朝の処理と外部送信を止める
2. このブランチを `main` に取り込む
3. `cron-worker` を公開する
4. LINE Developers の Webhook URL を `https://公開URL/reserve/api/line-webhook` に変える
5. HPの予約ボタン（`index.html` の5か所。今は STORES 宛）を `/reserve/` に変える
6. 古い `987sauna-kuwana.netlify.app` を新しいURLへ転送する（送信済みメールのリンクのため）

**戻すとき：** 取り込みを元に戻せば、今のHPに戻ります。データベースは同じなので、予約データは失われません。

## 確認すること

- ログイン（オーナー：ID＋パスワード、スタッフ：メールアドレスだけ、招待リンク）
- 予約、照会、キャンセル（お客様）
- 電話予約、キャンセル、復元、来店なし、精算（管理画面）
- 通知（メール、Discord、シート）
- 毎朝の処理
