# Rollberry

Rollberry は、指定した Web ページを上から下まで滑らかにスクロールさせた MP4 を生成する CLI です。`localhost`、`127.0.0.1`、`[::1]` の開発中 URL にも対応します。

## Requirements

- Node.js `24.12.0+`
- `ffmpeg` / `ffprobe`
- macOS を優先サポート

## Setup

```bash
corepack pnpm install
corepack pnpm exec playwright install chromium
```

## Usage

```bash
npx rollberry capture http://localhost:3000 \
  --out ./artifacts/demo.mp4 \
  --viewport 1440x900 \
  --fps 60 \
  --duration auto \
  --wait-for selector:body \
  --hide-selector '#cookie-banner'
```

リポジトリ内で開発実行する場合は次です。

```bash
corepack pnpm dev -- capture http://localhost:3000 \
  --out ./artifacts/demo.mp4 \
  --viewport 1440x900 \
  --fps 60 \
  --duration auto \
  --wait-for selector:body \
  --hide-selector '#cookie-banner'
```

ビルド後は次でも実行できます。

```bash
node dist/cli.js capture https://example.com --out ./artifacts/example.mp4
```

初回の `npx rollberry ...` 実行時に Chromium が未導入なら、Rollberry が Playwright Chromium を自動インストールします。`ffmpeg` / `ffprobe` は自動導入しないので、事前に PATH 上で使える必要があります。

## Sidecar Outputs

各キャプチャのたびに次を出力します。

- `video.mp4`: 本体動画
- `video.manifest.json`: 実行結果、環境、オプション、失敗内容
- `video.log.jsonl`: 1 行 1 JSON の運用ログ

`--manifest` と `--log-file` で出力先を個別に上書きできます。

## Localhost Behavior

- `http://localhost:*`、`https://localhost:*`、`http://127.0.0.1:*`、`http://[::1]:*` を許可
- `localhost` 系では接続拒否を `--timeout` まで 500ms 間隔で再試行
- `https://localhost` 系では自己署名証明書を許可
- dev server の自動起動はしません。URL は事前に起動済みである前提です

## Recommended Operational Flow

1. `regression.sample.json` をコピーして自分たちの `regression.sites.json` を作る
2. 重要な 10〜20 URL を登録する
3. リリース前に `corepack pnpm regression -- --config ./regression.sites.json` を実行する
4. `artifacts/regression/summary.json` と各 manifest を確認する

## Commands

```bash
corepack pnpm check
corepack pnpm test
corepack pnpm build
corepack pnpm regression -- --config ./regression.sites.json
```
