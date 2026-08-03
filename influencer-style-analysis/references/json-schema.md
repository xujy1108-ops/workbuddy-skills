# JSON 输出结构定义

达人风格分析的 JSON 输出结构。所有字段均使用英文键名，值可为中文。

---

## 完整 Schema

```json
{
  "search_keyword": "string — 用户输入的搜索关键词",
  "platform": "string — 平台标识：douyin | xiaohongshu | channels",
  "analysis_date": "string — 分析日期，ISO 8601 格式 YYYY-MM-DD",
  "total_creators": "number — 本次搜索匹配到的达人数量",
  "creators": [
    {
      "creator_info": {
        "creator_id": "string — 平台原始达人 ID",
        "creator_name": "string — 达人昵称",
        "creator_handle": "string — 达人账号（如 @xxx）",
        "avatar_url": "string — 头像 URL",
        "profile_url": "string — 主页链接",
        "follower_count": "number — 粉丝数",
        "following_count": "number — 关注数",
        "total_likes": "number — 总获赞数",
        "verified": "boolean — 是否认证",
        "verified_label": "string — 认证标签（如无则为 null）",
        "category": "string — 账号分类（如 美妆/穿搭/美食）",
        "location": "string — 所在地（如无则为 null）"
      },
      "sample_info": {
        "total_posts_analyzed": "number — 本次分析的素材数量",
        "date_range_start": "string — 采集素材最早日期",
        "date_range_end": "string — 采集素材最晚日期",
        "data_sufficient": "boolean — 样本是否充足（>=10 条为 true）"
      },
      "style_profile": {
        "visual_style": {
          "score": "number — 维度总分 0-100",
          "level": "string — 优秀|良好|及格|偏弱|缺失",
          "shooting_techniques": {
            "camera_movement": ["string — 运镜方式列表"],
            "shot_sizes": ["string — 景别使用列表"],
            "angles": ["string — 机位角度列表"],
            "composition": ["string — 构图方式列表"],
            "score": "number — 子项评分 0-100"
          },
          "editing_style": {
            "transition_frequency": "string — 转场频率描述（高/中/低）",
            "avg_transitions_per_minute": "number — 每分钟平均转场次数",
            "rhythm": "string — 节奏描述（快/中/慢）",
            "effects_usage": ["string — 常用特效列表"],
            "sound_visual_sync": "string — 声画配合描述",
            "score": "number — 子项评分 0-100"
          },
          "visual_tone": {
            "color_preference": "string — 色彩偏好描述",
            "primary_colors": ["string — 主色调列表（如 hex 或色名）"],
            "filter_style": "string — 滤镜风格描述",
            "brightness": "string — 画面明暗描述（高调/低调/中间调）",
            "subtitle_style": "string — 字幕/文字风格描述",
            "score": "number — 子项评分 0-100"
          },
          "pacing": {
            "information_density": "string — 信息密度描述（高/中/低）",
            "avg_shot_duration_sec": "number — 平均单镜头时长（秒）",
            "dynamic_static_ratio": "string — 动静比例描述",
            "score": "number — 子项评分 0-100"
          }
        },
        "content_style": {
          "score": "number — 维度总分 0-100",
          "level": "string — 优秀|良好|及格|偏弱|缺失",
          "copy_tone": {
            "primary_tone": "string — 主基调（专业/轻松/感性/幽默/理性/励志）",
            "emotional_tendency": "string — 情感倾向描述",
            "approachability": "string — 亲和力描述",
            "score": "number — 子项评分 0-100"
          },
          "topic_direction": {
            "main_topics": [
              {
                "topic": "string — 主题名称",
                "proportion": "number — 占比 0-1"
              }
            ],
            "content_angles": ["string — 选题角度列表"],
            "trend_tracking": "string — 热点追踪能力描述",
            "originality": "string — 原创性描述",
            "score": "number — 子项评分 0-100"
          },
          "narrative_structure": {
            "hook_type": "string — 开篇方式（提问/悬念/冲突/直入/数据冲击）",
            "body_structure": "string — 正文结构（总分总/并列/递进/对比/时间线）",
            "ending_pattern": "string — 结尾模式（总结/互动/预告/号召/情感升华）",
            "avg_duration_sec": "number — 平均视频时长（秒）",
            "avg_copy_length": "number — 平均文案字数",
            "score": "number — 子项评分 0-100"
          },
          "word_preferences": {
            "top_keywords": ["string — 高频词汇 Top 10"],
            "industry_terms": ["string — 行业术语列表"],
            "colloquial_level": "string — 口语化程度（高/中/低）",
            "trend_words_usage": "string — 流行语使用情况描述",
            "score": "number — 子项评分 0-100"
          }
        },
        "operational_style": {
          "score": "number — 维度总分 0-100",
          "level": "string — 优秀|良好|及格|偏弱|缺失",
          "posting_frequency": {
            "daily_avg": "number — 日均发布量",
            "weekly_avg": "number — 周均发布量",
            "avg_interval_hours": "number — 平均发布间隔（小时）",
            "trend": "string — 更新趋势（上升/下降/稳定）",
            "score": "number — 子项评分 0-100"
          },
          "posting_time": {
            "active_hours": ["string — 活跃时段列表（如 18:00-22:00）"],
            "regularity": "string — 时间规律性描述",
            "best_performance_hour": "string — 最佳表现时段",
            "score": "number — 子项评分 0-100"
          },
          "content_theme_distribution": {
            "themes": [
              {
                "theme": "string — 主题名称",
                "proportion": "number — 占比 0-1",
                "avg_engagement": "number — 该主题平均互动量"
              }
            ],
            "exploration_tendency": "string — 探索新主题倾向描述",
            "score": "number — 子项评分 0-100"
          },
          "fan_interaction": {
            "reply_habit": "string — 回复评论习惯描述",
            "interaction_methods": ["string — 互动引导方式列表"],
            "estimated_fan_profile": "string — 推测的粉丝画像",
            "community_operation": "string — 社群运营情况描述",
            "score": "number — 子项评分 0-100"
          }
        }
      },
      "top_content": [
        {
          "content_id": "string — 内容 ID",
          "title": "string — 标题",
          "url": "string — 链接",
          "publish_time": "string — 发布时间 ISO 8601",
          "duration_sec": "number — 视频时长（秒），图文为 null",
          "likes": "number — 点赞数",
          "comments": "number — 评论数",
          "shares": "number — 转发数",
          "collects": "number — 收藏数",
          "views": "number — 播放量",
          "copy_text": "string — 文案内容",
          "style_tags": ["string — 风格标签列表"],
          "engagement_rate": "number — 互动率 0-1"
        }
      ],
      "overall_assessment": {
        "overall_score": "number — 综合评分 0-100",
        "overall_level": "string — 优秀|良好|及格|偏弱|缺失",
        "style_summary": "string — 风格概述（2-3 句话总结达人风格特征）",
        "distinctive_features": ["string — 鲜明风格特征列表"],
        "content_strengths": ["string — 内容优势列表"],
        "improvement_suggestions": ["string — 改进建议列表"],
        "data_limitations": "string — 数据局限性说明（样本不足时标注）"
      }
    }
  ]
}
```

---

## 字段约定

| 规则 | 说明 |
|------|------|
| 数值型字段 | 无数据时填 `null`，不填 0 |
| 列表型字段 | 无数据时填空数组 `[]` |
| 评分字段 | 统一 0-100 分制，保留一位小数 |
| 日期字段 | ISO 8601 格式（`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm:ss`） |
| 占比字段 | 0-1 之间的小数（如 0.35 表示 35%） |
| 互动率 | (点赞+评论+转发+收藏) / 播放量，0-1 之间 |

## 权重配置

默认三维度等权重，可在 `overall_assessment.overall_score` 计算时调整：

| 维度 | 默认权重 |
|------|----------|
| 视觉/视频风格 | 33.3% |
| 内容/文案风格 | 33.3% |
| 运营/行为风格 | 33.4% |

如有特殊需求，可在 SKILL.md 的注意事项中定义权重调整规则。
