import json
import sys

import pjsekai_scores_rs


MAX_SUS_BYTES = 4 * 1024 * 1024


def main():
    payload = json.load(sys.stdin)
    sus = str(payload.get("sus", ""))
    if not sus or len(sus.encode("utf-8")) > MAX_SUS_BYTES:
        raise ValueError("invalid SUS payload")

    score = pjsekai_scores_rs.Score.from_str(sus)
    score.set_meta(
        title=str(payload.get("title", "")),
        artist=str(payload.get("artist", "")),
        difficulty=str(payload.get("difficulty", "")),
        playlevel=str(payload.get("level", "")),
    )
    drawing = pjsekai_scores_rs.Drawing(
        score=score,
        target_segment_seconds=8.0,
        generator="MizukiBot PJSK",
        font_dirs=[str(item) for item in payload.get("fontDirs", [])],
    )
    sys.stdout.buffer.write(drawing.png())


if __name__ == "__main__":
    main()
