#!/usr/bin/env python3
"""
extract_seed_biomes.py
=======================

指定したMinecraftのシード値について、広い範囲のバイオーム配置を計算し、
Minecraft AI Companion (ナビ) の seed_knowledge.js 形式でファイル出力するスクリプトです。

【重要な注意事項(必ず読んでください)】

1. このスクリプトは Java Edition 向けにバイオーム生成を再現する
   "cubiomes" ライブラリの Python バインディング (pybiomes) を利用します。
   Minecraft 1.18 以降、Java版と統合版(Bedrock)はオーバーワールドの地形・バイオーム生成が
   共通化されているため、統合版のシード値でもバイオームはかなり正確に再現できます。

2. 一方で「村」「要塞」「古代都市」などの構造物は、Java版と統合版で配置アルゴリズムが
   異なります。このスクリプトはバイオームのみを対象としており、構造物の座標は含めていません。
   構造物が欲しい場合は、統合版に対応したChunkbaseのSeed Map
   (https://www.chunkbase.com/apps/seed-map) で個別に調べて、
   seed_knowledge.js に手動で追記することをお勧めします。


必要なパッケージ:
    pip install numpy scipy
    pip install git+https://github.com/ScriptLineStudios/pybiomes --recursive
    (pybiomesはソースからのビルドが必要です。C言語のビルド環境(Windowsならvisual studio
    build tools、macOS/LinuxならGCC/Clang)が必要になる場合があります)

    ※ pybiomes のインストールがうまくいかない場合は、同じcubiomesベースの別バインディング
      (cubiomespi, Pyubiomes, cubiomes-python など)でも、biome生成部分のAPIを読み替えれば
      同じ考え方で動かせるはずです。
"""

import json
import sys
from pathlib import Path

# ==============================
# 設定(ここを書き換えてください)
# ==============================

SEED = 6942710633571786          # ワールドのシード値
MC_VERSION_NAME = "MC_1_21_1"    # pybiomes.versions の中から、お使いのMinecraftバージョンに近いものを選ぶ

CENTER_X = 0                     # 探索の中心座標(通常はスポーン地点周辺の0,0でよい)
CENTER_Z = 0
SURFACE_Y = 64                   # バイオーム判定に使う高さ(オーバーワールドの地表付近)

SCAN_RADIUS = 4000               # 中心から何ブロック四方を探索するか(大きいほど時間がかかる)
STEP = 16                        # サンプリング間隔(ブロック)。小さいほど精密だが遅くなる
MIN_PATCH_SAMPLES = 4            # この個数以上サンプルが連続していないと「意味のある範囲」とみなさない

OUTPUT_PATH = Path("seed_knowledge.js")  # 出力ファイル(このままbehavior_pack/scripts/にコピーする想定)

# 出力に含めたくない、ありふれたバイオーム(必要に応じて増減してください)
# ここに含めなければ、そのバイオームの patch は出力に含まれません。
# 空リストにすると、見つかった全バイオームを出力します(ファイルが大きくなる点に注意)。
INTERESTING_BIOMES = [
    # 珍しめ・目印になりやすいバイオームの例。プレイヤーの興味に合わせて調整してください。
    "cherry_grove", "mushroom_fields", "ice_spikes", "badlands", "eroded_badlands",
    "wooded_badlands", "jungle", "bamboo_jungle", "sparse_jungle", "mangrove_swamp",
    "swamp", "desert", "savanna", "savanna_plateau", "windswept_savanna",
    "snowy_taiga", "old_growth_pine_taiga", "old_growth_spruce_taiga",
    "dark_forest", "flower_forest", "sunflower_plains", "birch_forest",
    "old_growth_birch_forest", "meadow", "grove", "snowy_slopes",
    "jagged_peaks", "frozen_peaks", "stony_peaks", "frozen_river",
    "deep_frozen_ocean", "warm_ocean", "lukewarm_ocean", "cold_ocean",
    "deep_ocean", "beach", "snowy_beach", "stony_shore",
]


def main():
    try:
        import pybiomes
        import sys as _sys
        import pybiomes.dimensions   # sys.modulesに登録させるためのimport(属性としては使わない)
        import pybiomes.versions     # 同上
        mc_versions = _sys.modules["pybiomes.versions"]
        DIM_OVERWORLD = _sys.modules["pybiomes.dimensions"].DIM_OVERWORLD
    except ImportError as e:
        print(f"詳細エラー: {e}", file=sys.stderr)
        print(
            "pybiomes が見つかりません。README冒頭のコメントを参照してインストールしてください。",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        import numpy as np
    except ImportError:
        print("numpy が見つかりません。`pip install numpy` を実行してください。", file=sys.stderr)
        sys.exit(1)

    try:
        from scipy import ndimage
        has_scipy = True
    except ImportError:
        has_scipy = False
        print(
            "警告: scipy が見つからないため、簡易的な(やや遅い)自前の連結成分探索を使います。"
            " `pip install scipy` でより高速になります。",
            file=sys.stderr,
        )

    mc_version = getattr(mc_versions, MC_VERSION_NAME, None)
    if mc_version is None:
        print(f"MC_VERSION_NAME '{MC_VERSION_NAME}' が pybiomes.versions に見つかりません。", file=sys.stderr)
        sys.exit(1)

    generator = pybiomes.Generator(mc_version, 0)
    generator.apply_seed(SEED, DIM_OVERWORLD)

    # --- (a) サニティチェック: スポーン地点付近のバイオームを表示 ---
    print("=== サニティチェック ===")
    for (cx, cz) in [(0, 0), (CENTER_X, CENTER_Z)]:
        try:
            biome_id = generator.get_biome_at(1, cx, SURFACE_Y, cz)
            print(f"  ({cx}, {SURFACE_Y}, {cz}) -> biome_id={biome_id} ({biome_id_to_name(pybiomes, biome_id)})")
        except Exception as e:
            print(f"  ({cx}, {SURFACE_Y}, {cz}) -> エラー: {e}")
    print(
        "  ↑ 実際にゲーム内でこの座標(またはスポーン地点)のバイオームを確認し、"
        "一致するか必ず確認してください。\n"
    )

    # --- (b) グリッドスキャン ---
    xs = list(range(CENTER_X - SCAN_RADIUS, CENTER_X + SCAN_RADIUS + 1, STEP))
    zs = list(range(CENTER_Z - SCAN_RADIUS, CENTER_Z + SCAN_RADIUS + 1, STEP))
    print(f"スキャン範囲: {len(xs)} x {len(zs)} = {len(xs) * len(zs)} 点(STEP={STEP}ブロック間隔)")

    grid = np.full((len(xs), len(zs)), -1, dtype=np.int32)

    total = len(xs) * len(zs)
    done = 0
    for i, x in enumerate(xs):
        for j, z in enumerate(zs):
            try:
                grid[i, j] = generator.get_biome_at(1, x, SURFACE_Y, z)
            except Exception:
                grid[i, j] = -1
            done += 1
        if i % max(1, len(xs) // 20) == 0:
            print(f"  進捗: {done}/{total} ({done * 100 // total}%)")

    print("スキャン完了。バイオームごとの連結領域(patch)を抽出します...")

    # --- (c) 同じバイオームが連続している領域(patch)ごとに中心座標を求める ---
    landmarks = []
    unique_biomes = sorted(set(grid.flatten().tolist()) - {-1})

    for biome_id in unique_biomes:
        name = biome_id_to_name(pybiomes, biome_id)
        if INTERESTING_BIOMES and name not in INTERESTING_BIOMES:
            continue

        mask = grid == biome_id

        if has_scipy:
            labeled, num_features = ndimage.label(mask)
            for label_id in range(1, num_features + 1):
                ys_idx, zs_idx = np.where(labeled == label_id)
                if len(ys_idx) < MIN_PATCH_SAMPLES:
                    continue
                center_i = int(round(ys_idx.mean()))
                center_j = int(round(zs_idx.mean()))
                world_x = xs[center_i]
                world_z = zs[center_j]
                landmarks.append(
                    {
                        "label": name,
                        "category": "biome",
                        "x": world_x,
                        "y": SURFACE_Y,
                        "z": world_z,
                        "dimensionId": "overworld",
                    }
                )
        else:
            for (world_x, world_z) in simple_patch_centers(mask, xs, zs, MIN_PATCH_SAMPLES):
                landmarks.append(
                    {
                        "label": name,
                        "category": "biome",
                        "x": world_x,
                        "y": SURFACE_Y,
                        "z": world_z,
                        "dimensionId": "overworld",
                    }
                )

    print(f"抽出された landmark 件数: {len(landmarks)}")

    write_seed_knowledge_js(landmarks, OUTPUT_PATH)
    print(f"書き出し完了: {OUTPUT_PATH.resolve()}")
    print("このファイルの中身を behavior_pack/scripts/seed_knowledge.js にコピーしてください。")


def biome_id_to_name(pybiomes_module, biome_id):
    """pybiomes.biomes モジュールの定数から、biome_idに対応する名前を逆引きする。"""
    biomes_module = getattr(pybiomes_module, "biomes", None)
    if biomes_module is None:
        return str(biome_id)
    if not hasattr(biome_id_to_name, "_cache"):
        cache = {}
        for attr in dir(biomes_module):
            if attr.startswith("_"):
                continue
            value = getattr(biomes_module, attr)
            if isinstance(value, int):
                cache[value] = attr
        biome_id_to_name._cache = cache
    return biome_id_to_name._cache.get(biome_id, str(biome_id))


def simple_patch_centers(mask, xs, zs, min_samples):
    """scipyが無い場合の簡易的な連結成分探索(BFS)。大きいグリッドではscipy版より遅い。"""
    import numpy as np

    visited = np.zeros_like(mask, dtype=bool)
    h, w = mask.shape
    centers = []

    for i in range(h):
        for j in range(w):
            if not mask[i, j] or visited[i, j]:
                continue
            stack = [(i, j)]
            visited[i, j] = True
            cells = []
            while stack:
                ci, cj = stack.pop()
                cells.append((ci, cj))
                for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ni, nj = ci + di, cj + dj
                    if 0 <= ni < h and 0 <= nj < w and mask[ni, nj] and not visited[ni, nj]:
                        visited[ni, nj] = True
                        stack.append((ni, nj))
            if len(cells) < min_samples:
                continue
            avg_i = sum(c[0] for c in cells) / len(cells)
            avg_j = sum(c[1] for c in cells) / len(cells)
            centers.append((xs[int(round(avg_i))], zs[int(round(avg_j))]))

    return centers


def write_seed_knowledge_js(landmarks, output_path):
    lines = []
    lines.append("// このファイルは extract_seed_biomes.py によって自動生成されました。")
    lines.append("// behavior_pack/scripts/seed_knowledge.js を、このファイルの内容で上書きしてください。")
    lines.append("// カテゴリ「biome」はこのスクリプトが自動抽出したもの、")
    lines.append("// 「structure」など他のカテゴリはChunkbase等で手動調査したものを別途追記してください。")
    lines.append("")
    lines.append("export const SEED_KNOWLEDGE = [")
    for lm in landmarks:
        lines.append(
            "  { label: %s, category: %s, x: %d, y: %d, z: %d, dimensionId: %s },"
            % (
                json.dumps(lm["label"], ensure_ascii=False),
                json.dumps(lm["category"], ensure_ascii=False),
                lm["x"],
                lm["y"],
                lm["z"],
                json.dumps(lm["dimensionId"], ensure_ascii=False),
            )
        )
    lines.append("];")
    lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
