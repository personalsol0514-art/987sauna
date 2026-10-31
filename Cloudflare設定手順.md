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

`nodejs_compat` と互換日付は、リポジトリの `wrangler.toml` で設定済みです。画面での設定は不要です。

注意：Cloudflare の仕様で、このファイルを含むデプロイがあると、その環境（プレビューまたは本番）の設定はファイルが優先になり、画面では見るだけになります。プレビューの設定はブランチごとではなく、プレビュー全体に効きます。やめるときは、ファイルを消して再デプロイすれば画面で編集できる状態に戻ります。

## 3. 環境変数（Pages の Settings → Variables and Secrets）

すべて「Secret」で、**本番（Production）とプレビュー（Preview）の両方に同じ値**を登録してください。値は、かずやから受け取ってください。

| 名前 | 内容 |
|---|---|
| `DATABASE_URL` | 予約データの保管場所（Neon）につなぐ住所。このサイト専用の鍵で、表を作り替える権限はありません |
| `ADMIN_JWT_SECRET` | 管理画面のログインを守る合言葉 |
| `CRON_SECRET` | 毎朝8時の処理を呼ぶための合言葉 |
| `DISCORD_WEBHOOK_URL` | お店の Discord への通知先 |
| `GAS_MAIL_URL` | メール送信・シート記録の窓口 |
| `GAS_MAIL_TOKEN` | 上の窓口の合言葉 |
| `ADMIN_RECOVERY_EMAIL` | パスワード再設定の送り先 |
| `LINE_CHANNEL_ACCESS_TOKEN` | お店の公式LINE（友だち登録の記録用） |
| `LINE_CHANNEL_SECRET` | お店の公式LINE |
| `MAI_LINE_TOKEN` | エラー時に「mai」から通知するためのアクセストークン |
| `MAI_LINE_TO` | エラー通知の送信先 |

`OUTBOUND_DELIVERY_ENABLED`（送信の有効化）と、プレビュー・本番それぞれの `SITE_ORIGIN` は `wrangler.toml` に書いてあります。本番URLは `https://987sauna.pages.dev` です。

**プレビューも本番と同じデータを使います。** プレビューで予約や精算をすると、本物の記録に残ります。プレビューからはメール・Discord・シートへの送信はしません。

## 4. 毎朝8時の処理

Cloudflare 側の設定は不要です。切り替え後に、かずやのサーバーから毎朝8時に `/reserve/api/cron-daily` を呼びます（`CRON_SECRET` で守られています）。

## 5. 本番への切り替え（確認が終わってから）

**このブランチを `main` に取り込むと、HPの予約ボタン5か所が STORES から `/reserve/` に変わります。** STORES の予約ページも残っている間は、同じ枠に両方から予約が入らないよう、切り替えの前に STORES 側の枠を閉じてください。

1. STORES の新規受付を止める（既存の予約の扱いも決める）
2. かずや側で、本番のデータベースに `create extension if not exists pgcrypto;` を実行する（パスワード確認に必要）
3. Pages の本番に環境変数を設定する（`OUTBOUND_DELIVERY_ENABLED=true` と本番の `DATABASE_URL`）
4. このブランチを `main` に取り込む
5. `/reserve/` で空き枠が出ること、`/reserve/admin` にログインできることを確認する
6. かずや側で Netlify を転送に切り替える（毎朝の処理もここで止まる。転送の設定は用意済み）
7. かずや側で、毎朝8時の呼び出しを有効にする
8. LINE Developers の Webhook URL を `https://公開URL/reserve/api/line-webhook` に変える

6と7の順番を守ってください。Netlify と同時に動くと、リマインドメールやシート更新が二重になります。

**戻すとき：** 取り込みを元に戻せば、今のHPに戻ります。Netlify の転送も外せば、今の予約システムに戻ります。データベースは同じなので、予約データは失われません。

## ブランチを本番に入れる前の注意

リポジトリは公開設定です。`functions/` のファイルもサイトから読める場所に置かれますが、秘密の値は入っていません。

## 確認すること

- ログイン（オーナー：ID＋パスワード、スタッフ：メールアドレスだけ、招待リンク）
- 予約、照会、キャンセル（お客様）
- 電話予約、キャンセル、復元、来店なし、精算（管理画面）
- 通知（メール、Discord、シート）
- 毎朝の処理

## 部品の更新（開発者向け）

Cloudflare Pages はビルド時に npm の部品を入れないため、Neon への接続とログインの署名に使う部品を `functions/_reserve/vendor/npm.js` に同梱しています。部品を新しくするときは、次のコマンドで作り直します。

```bash
npm install
printf 'module.exports={neon:require("@neondatabase/serverless"),jwt:require("jsonwebtoken")};' > .vendor-entry.js
npx esbuild .vendor-entry.js --bundle --platform=node --format=cjs --target=es2022 --legal-comments=eof --outfile=functions/_reserve/vendor/npm.js
rm .vendor-entry.js
```
