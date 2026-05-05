# 3DGSルームツアーシステム設計書

## 概要
3ds Maxで制作したマンションCGをVantageで書き出し、Gaussian Splatting（3DGS）として軽量化し、
PlayCanvas Engine上で回遊可能なルームツアーとして提供する。

## 機能一覧
- 3DGS回遊（PlayCanvas Engine + GSplat）
- URL共有による閲覧
- 図面表示（現在位置表示）
- 視点ジャンプ（玄関/リビング/キッチン/寝室/洗面）
- コリジョン制御（壁抜け防止）
- コリジョン可視化（デバッグ用）
- マテリアル変更プレビュー（将来）

## 技術スタック
- PlayCanvas Engine (GSplat rendering + collision)
- React + TypeScript + Vite (UI)
- Zustand (state management)
- ammo.js (collision raycasting)
- Static hosting (Vercel/Cloudflare Pages)

## 利用者区分
### 開発者: デバッグUI、コリジョン可視化、編集ポイント表示
### 閲覧者: シンプルUI、視点ジャンプ、図面表示

## コリジョン設計
- GLB形式（FBXではなくPlayCanvas native）
- collision_walkable: 床
- collision_block: 壁、大型家具
- レイキャスト方式（物理シミュレーションではなく）

## 実装フェーズ
1. Splat Viewer + カメラ
2. 視点ジャンプ + URL共有
3. コリジョンシステム
4. 図面 + デバッグモード
5. ポリッシュ + デプロイ
6. マテリアル変更プレビュー（将来）
