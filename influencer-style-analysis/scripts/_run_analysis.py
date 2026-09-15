"""临时 runner — 分析达人风格"""
import sys, json, os
sys.path.insert(0, os.path.dirname(__file__))

from agents.influencer_profiler import run_influencer_profiler

url = "https://www.douyin.com/user/MS4wLjABAAAAsYaohHQsHYz6K_FTMpqxlhkcWTI7toGwcoUsB5QK2r29G74iIkYO9KG3qq77ParM"
result = run_influencer_profiler(url)

# 保存结果
with open("analysis_result.json", "w", encoding="utf-8") as f:
    json.dump(result.raw if hasattr(result, 'raw') else result, f, ensure_ascii=False, indent=2)

# 如果 result 是 AgentResult，取 text
if hasattr(result, 'text'):
    try:
        data = json.loads(result.text)
        with open("analysis_result.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        with open("analysis_result_pretty.json", "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        print("DONE - saved to analysis_result.json")
    except:
        print(result.text[:2000])
else:
    print(json.dumps(result, ensure_ascii=False, indent=2)[:2000])
