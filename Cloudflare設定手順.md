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

無料プランのまま、まずプレビューで試せます。無料プランは1回の処理の計算時間が10ミリ秒までなので、パスワードの確認はデータベース側で行うようにしました。

ほかの処理が上限に収まるかは、本物の環境で試して判断します。上限を超えるとお客様の予約がエラーになるので、**本番では Workers の有料プラン（月5ドルから）をおすすめします。**

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

**このブランチを `main` に取り込むと、HPの予約ボタン5か所が STORES から `/reserve/` に変わります。** STORES の予約ページも残っている間は、同じ枠に両方から予約が入らないよう、切り替えの前に STORES 側の枠を閉じてください。

1. STORES の新規受付を止める（既存の予約の扱いも決める）
2. かずや側で、本番のデータベースに `create extension if not exists pgcrypto;` を実行する（パスワード確認に必要）
3. Pages の本番に環境変数を設定する（`OUTBOUND_DELIVERY_ENABLED=true` と本番の `DATABASE_URL`）
4. このブランチを `main` に取り込む
5. `/reserve/` で空き枠が出ること、`/reserve/admin` にログインできることを確認する
6. かずや側で Netlify を転送に切り替える（毎朝の処理もここで止まる。転送の設定は用意済み）
7. `cron-worker` を公開する
8. LINE Developers の Webhook URL を `https://公開URL/reserve/api/line-webhook` に変える

6と7の順番を守ってください。同時に動くと、リマインドメールやシート更新が二重になります。

**戻すとき：** 取り込みを元に戻せば、今のHPに戻ります。Netlify の転送も外せば、今の予約システムに戻ります。データベースは同じなので、予約データは失われません。

## ブランチを本番に入れる前の注意

リポジトリは公開設定です。`functions/` や `cron-worker/` のファイルもサイトから読める場所に置かれますが、秘密の値は入っていません。

## 確認すること

- ログイン（オーナー：ID＋パスワード、スタッフ：メールアドレスだけ、招待リンク）
- 予約、照会、キャンセル（お客様）
- 電話予約、キャンセル、復元、来店なし、精算（管理画面）
- 通知（メール、Discord、シート）
- 毎朝の処理
