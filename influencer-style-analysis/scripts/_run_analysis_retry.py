"""临时 runner — 多候选视频 + 失败跳过重试"""
import sys, json, os, time
sys.path.insert(0, os.path.dirname(__file__))

from tools.tikhub import fetch_influencer_from_douyin
from agents.influencer_profiler import (
    _analyze_one_video, _build_text_payload, _merge_multiple_analyses,
    _parse_input,
)

URL = "https://www.douyin.com/user/MS4wLjABAAAAsYaohHQsHYz6K_FTMpqxlhkcWTI7toGwcoUsB5QK2r29G74iIkYO9KG3qq77ParM"

# 1. 多拉几个候选视频
bundle = fetch_influencer_from_douyin(profile_url=URL, video_count=5)
print(f"昵称: {bundle['author_nickname']}")
print(f"候选视频: {bundle['video_count']} 个")

data = dict(bundle)
data["douyin_profile_url"] = URL
user_text = _build_text_payload(data)

# 2. 逐个分析，失败跳过，成功 2 个即停
success_results = []
errors = []
for i, url in enumerate(bundle["video_urls"]):
    if len(success_results) >= 2:
        break
    _, result, err = _analyze_one_video(url, i, bundle["video_count"], user_text)
    if result is not None:
        success_results.append(result)
    else:
        errors.append(str(err)[:200])
        print(f"视频 {i+1} 失败，跳过")

if not success_results:
    print("ALL_FAILED:", json.dumps(errors, ensure_ascii=False))
    sys.exit(1)

print(f"成功分析 {len(success_results)} 个视频")

# 3. 合并（单视频直接用）
if len(success_results) == 1:
    final = success_results[0]
else:
    meta = {"source": "douyin", "sec_user_id": bundle.get("sec_user_id", "")}
    final = _merge_multiple_analyses(
        success_results, bundle["bio"], bundle["author_nickname"], meta
    )

with open("analysis_result_final.json", "w", encoding="utf-8") as f:
    json.dump(json.loads(final.text), f, ensure_ascii=False, indent=2)
print("DONE - saved to analysis_result_final.json")
