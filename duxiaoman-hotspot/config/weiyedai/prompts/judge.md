TODO_ 微业贷 AI 判断 prompt 模板（尚未补齐）

用法：把 config/duxiaoman/prompts/judge.md 整份复制过来，按微业贷的品牌口径重写，至少覆盖：
1. 角色：你是<品牌名>的金融热点选题编辑……
2. 符合度判断：本品牌的领域范围 + 相关性范围 + 受众重合判法
3. 禁止方向：本品牌合规红线（可参考度小满的第五点 + 涉军红线，按本品牌调整）
4. 语义锚点候选池：须与 config.json 的 strategy.anchorPool 完全一致
5. 跳数口径：终点是「借钱」不是品牌名；区分显式跳转 / 隐含前提
6. 跳数→植入方式：须与 config.json 的 strategy.placementByHops 一致
7. 运行时占位符必须原样保留：{platform} {source} {topic} {heat} {heat_text} {creator}
8. 输出格式：严格 JSON，字段名与度小满保持一致（fit / reason / semantic_anchor / hop_count / hop_path / implicit_premise / placement / strategy）

本文件里只要还残留 "TODO_" 字样，脚本会启动即报错。
