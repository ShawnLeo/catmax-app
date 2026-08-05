"""
从 resources/icon.png 派生托盘图标资源。

源图结构：透明背景 + #18181b 圆角方块 + 白色描边的猫。

产出两种字形，按尺寸分档使用（见 LINE_ART_MIN_SIZE）：

- 线稿：直接取白描边（轮廓 / 耳 / 眼 / 鼻 / 嘴 / 尾 / 腿），其余透明，和 logo 观感一致。
  但原图线宽只有约 13px，而猫的 bbox 约 560px——缩到 16px 后线宽剩 0.4px，会淡到
  看不见，所以每一档都要先按缩放比把线条膨胀回约 1.4px 再缩小。
- 剪影：实心猫形。丢掉全部细节，换来小尺寸下仍然认得出。

实测可读性临界点在 24~32px 之间：48px 线稿细节完整，32px 五官仍可辨，
24px 只剩轮廓，16/20px 糊成一团。所以 32px 以上走线稿，以下退回剪影。
macOS Retina 用 @2x（32px 渲染 16pt），所以 Mac 上看到的是线稿。

猫身和方块底色是同一个黑（#18181b），颜色分不开，所以剪影不能靠阈值抠，
改用 flood fill：从方块背景灌水，白描边天然成为水坝，灌不到的黑区就是猫身。
"""

import os

from PIL import Image, ImageChops, ImageDraw, ImageFilter

SRC = "resources/icon.png"
OUT = "resources/tray"

# 小于这个尺寸的档位用剪影，大于等于的用线稿
LINE_ART_MIN_SIZE = 32
# 线稿缩小后希望达到的线宽（像素）
TARGET_STROKE_PX = 1.4
# 源图白描边的大致线宽
SRC_STROKE_PX = 13

im = Image.open(SRC).convert("RGBA")
W, H = im.size
alpha = im.getchannel("A")
gray = im.convert("L")

# ---------- 线稿：白描边就是要的图形 ----------
# 亮度 × alpha：方块外 alpha=0 自然归零，只留方块内的亮部。
line_src = ImageChops.multiply(gray, alpha)
# 方块底色亮度约 24，会留一层淡底噪；线性拉伸把它压到 0、白线拉到 255。
_FLOOR = 60
line_src = line_src.point(lambda v: max(0, min(255, round((v - _FLOOR) * 255 / (255 - _FLOOR)))))

# ---------- 剪影：flood fill 反选 ----------
# wall=255（白描边 / 方块外的透明区），open=0（方块底色 + 猫身）
fl = Image.new("L", (W, H), 255)
fl_px = fl.load()
a_px = alpha.load()
g_px = gray.load()
for y in range(H):
    for x in range(W):
        if a_px[x, y] > 128 and g_px[x, y] < 128:
            fl_px[x, y] = 0

# 种子点：沿中轴线从上往下找第一个 open 像素，那里必定是猫头顶上方的方块背景
seed = None
for y in range(H):
    if fl_px[W // 2, y] == 0:
        seed = (W // 2, y + 2)
        break
assert seed is not None, "找不到方块背景种子点"
ImageDraw.floodfill(fl, seed, 128, thresh=0)

sil_src = Image.new("L", (W, H), 0)
s_px = sil_src.load()
for y in range(H):
    for x in range(W):
        if a_px[x, y] > 128 and fl_px[x, y] != 128:
            s_px[x, y] = 255

print("silhouette bbox", sil_src.getbbox(), "line bbox", line_src.getbbox())

# 膨胀会往外长，先留出 margin，否则加粗后的线条会被画布边缘裁掉
_MARGIN = 48
_bx0, _by0, _bx1, _by1 = line_src.getbbox()
line_src = line_src.crop((_bx0 - _MARGIN, _by0 - _MARGIN, _bx1 + _MARGIN, _by1 + _MARGIN))


def fit(mask: Image.Image, size: int, pad: int) -> Image.Image:
    """按自身 tight bbox 等比缩放到 size×size 画布内，四周留 pad 像素。

    先取 bbox 再缩放，保证每一档都填满画布——线稿膨胀后 bbox 会变大，
    不重新取的话各档的猫会一档比一档小。
    """
    trimmed = mask.crop(mask.getbbox())
    inner = size - pad * 2
    w, h = trimmed.size
    scale = min(inner / w, inner / h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    canvas = Image.new("L", (size, size), 0)
    canvas.paste(trimmed.resize((nw, nh), Image.LANCZOS), ((size - nw) // 2, (size - nh) // 2))
    return canvas


def dilation_for(size: int, pad: int) -> int:
    """算出这一档需要多大的 MaxFilter，才能让缩小后的线宽回到 TARGET_STROKE_PX。

    MaxFilter(n) 让线宽增加 n-1，所以 n = 目标源线宽 - 原线宽 + 1。取奇数（PIL 要求）。
    """
    inner = size - pad * 2
    scale = inner / max(line_src.size)
    needed_src_stroke = TARGET_STROKE_PX / scale
    n = round(needed_src_stroke - SRC_STROKE_PX + 1)
    n = max(1, n)
    return n if n % 2 == 1 else n + 1


def glyph(size: int, pad: int) -> Image.Image:
    """按尺寸挑字形：够大用线稿，太小用剪影。"""
    if size >= LINE_ART_MIN_SIZE:
        d = dilation_for(size, pad)
        mask = line_src.filter(ImageFilter.MaxFilter(d)) if d > 1 else line_src
        kind = f"line(dilate={d})"
    else:
        mask = sil_src
        kind = "silhouette"
    return fit(mask, size, pad), kind


def colorize(mask: Image.Image, rgb: tuple[int, int, int]) -> Image.Image:
    out = Image.new("RGBA", mask.size, rgb + (0,))
    out.putalpha(mask)
    return out


os.makedirs(OUT, exist_ok=True)

# macOS 模板图：纯黑 + alpha，系统按菜单栏明暗自动反色。彩色图不会反色。
# 16pt 基准，@2x/@3x 供 Retina；文件名以 Template 结尾时 Electron 自动识别。
for suffix, size, pad in [("", 16, 1), ("@2x", 32, 2), ("@3x", 48, 3)]:
    mask, kind = glyph(size, pad)
    colorize(mask, (0, 0, 0)).save(f"{OUT}/trayTemplate{suffix}.png")
    print(f"wrote trayTemplate{suffix}.png {size}x{size} {kind}")

# Windows 没有模板图机制，不会反色，只能按任务栏明暗备两套。
# 常见 DPI 档位：100%=16, 125%=20, 150%=24, 200%=32。
ICO_SIZES = [64, 48, 40, 32, 24, 20, 16]
for name, rgb in [("tray-on-dark", (255, 255, 255)), ("tray-on-light", (24, 24, 27))]:
    frames = []
    for s in ICO_SIZES:
        mask, kind = glyph(s, max(1, round(s / 16)))
        frames.append(colorize(mask, rgb))
    # PIL 的 ICO 编码器以 base 图为准，base 必须是最大尺寸，
    # 否则小于 base 的档位会被静默丢掉（只剩 16x16）。ICO_SIZES 已按降序排列。
    frames[0].save(
        f"{OUT}/{name}.ico",
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=frames[1:],
    )
    print(f"wrote {name}.ico {ICO_SIZES}")
