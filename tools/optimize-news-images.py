"""Regenerate committed responsive derivatives; requires Pillow (development only)."""
import json
from pathlib import Path
from PIL import Image, ImageOps

root = Path(__file__).resolve().parents[1]
out = root / 'public/news-media/responsive'
out.mkdir(parents=True, exist_ok=True)
manifest = {}
for story in json.loads((root / 'src/data/stories.json').read_text())['stories']:
    source = root / 'public' / story['image']
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original).convert('RGB')
        width, height = image.size
        variants = []
        for size in sorted({min(width, size) for size in (320, 640, 1024)}):
            path = out / f'{story["id"]}-{size}.webp'
            image.resize((size, round(height * size / width)), Image.Resampling.LANCZOS).save(path, 'WEBP', quality=82, method=6)
            variants.append(size)
        manifest[str(story['id'])] = {'width': width, 'height': height, 'variants': variants}
(root / 'src/data/image-sizes.json').write_text(json.dumps(manifest, indent=2) + '\n')
