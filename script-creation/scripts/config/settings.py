"""配置管理：环境变量 + 飞书表配置。"""

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # ── LLM (inferera / deepseek-v4-pro) ──
    deepseek_api_key: str
    deepseek_base_url: str = "https://api.inferera.com/v1"
    deepseek_model: str = "deepseek-v4-pro"

    # ── 代理 ──
    http_proxy: str | None = None
    https_proxy: str | None = None


# ── 飞书多维表格配置（非密钥，硬编码） ──

# 创意策略表（步骤 directions 的驱动源：达人画像匹配策略行）
FEISHU_STRATEGY_BASE = "EPYhbxo9TaUclysWuM0cgjkdnFf"
FEISHU_STRATEGY_TABLE = "tblSZ8LbahG9GnCH"

# 热点素材库（蹭热点线创意方向来源，按素材评分取优）
FEISHU_HOTSPOT_BASE = "STMrbQgqma35dksI3WsclJlNnlc"
FEISHU_HOTSPOT_TABLE = "tblDpxkM7psozqeO"

# 网络素材库（策略行素材链接ids 反查源）
FEISHU_MATERIALS_BASE = "RFAqblL7FahLxps2SsNcoyxjnWh"
FEISHU_MATERIALS_TABLE = "tblYEQ0raRDrB4tb"

# 历史数据库（2026-09-09 改造：历史库退出 directions 流程，保留配置供其他步骤可能使用）
FEISHU_HISTORY_BASE = "IusNb2cgTafYo4sTVntcHNJHn9f"
FEISHU_HISTORY_TABLE_TOUTIAO = "tblBEveR1P0gKRyy"

# 内容标准文档（2026-09-09 停用：大纲步骤已移除，写作约束改由脚本 SOP 文档承载）
CONTENT_STANDARD_DOC_URL = "https://kwza968lz1u.feishu.cn/docx/ZdJMd6L1uo7lkwxSgKkcvXawnLc"

# 脚本 SOP 文档（写稿依据，按 track 分线注入：蹭热点→热点 SOP；其他方向→非热点 SOP）
SOP_HOTSPOT_DOC_URL = "https://kwza968lz1u.feishu.cn/docx/OBkUdT47XoctsxxHBExce92Xn1c"
SOP_NONHOTSPOT_DOC_URL = "https://kwza968lz1u.feishu.cn/docx/D3DQdyllxoEIgyxhHi4cyYzfnng"

# 口播脚本评分标准文档（写稿后评分依据：第0条合规红线一票否决 + 8 维度各 0-2 分）
SCORING_STANDARD_DOC_URL = "https://kwza968lz1u.feishu.cn/docx/WxwmdfYIeowjPLxvznWcfS7Nnle"


def get_settings() -> Settings:
    return Settings()
